/**
 * What Bro already knows, gathered for ONE browser errand.
 *
 * WHY a separate loader. The Cloud errand lane never read the `address` and
 * `contact` vault kinds at all — `browser_task.ts` filters the vault to
 * `kind === "payment"` and `vault-login.ts` picks `login`, so the two kinds
 * that hold the human's street, name, phone and email were only ever used by
 * the Kernel worker's autofill subagent. The tenant's timezone and their
 * display name never reached a run either. The result was a run that aborted
 * with «НУЖНО: address» for an address sitting in the vault two function
 * calls away.
 *
 * Everything here is NON-SECRET by construction: this loader parses the
 * `address` and `contact` payloads only. A `login` or `payment` payload is
 * never read, never parsed and never returned — those stay on the
 * `secretBindings` path (`agent/lib/browser-pay.ts`), where the Cloud server
 * types them into the page without either model seeing a character.
 *
 * Nothing here is allowed to fail an errand. Every call is individually
 * caught: a Convex hiccup, an unparseable payload or a missing tenant costs
 * the run some context, never the run itself. Worst case the facts come back
 * empty and the scaffold behaves exactly as it did before this shipped.
 */

import { resolveTenantTz } from "../../convex/lib/tzPolicy.ts";
import {
  parseAddressPayload,
  parseContactPayload,
} from "../../convex/lib/vaultPayload.ts";
import { getTenant, listVaultItems, readVaultSecret } from "./convex.ts";
import { type ErrandAddress, type ErrandFacts } from "./errand-brief.ts";

export type ErrandContextDeps = {
  getTenant: typeof getTenant;
  listVaultItems: typeof listVaultItems;
  readVaultSecret: typeof readVaultSecret;
};

const defaultDeps: ErrandContextDeps = {
  getTenant,
  listVaultItems,
  readVaultSecret,
};

/**
 * Current local date and time in `tz`, spelled out in Russian, weekday
 * included. The weekday is the point: «на воскресенье» is a calendar date
 * only once the run knows today is Thursday.
 */
export function formatLocalNow(tz: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(now);
  } catch {
    // `resolveTenantTz` already rejects garbage zones, so this is only
    // reachable on an engine without full ICU — a run without a clock is
    // still better than an errand that throws on its way to the browser.
    return "";
  }
}

async function safe<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.error(`errand context: ${what} failed`, err);
    return undefined;
  }
}

function addressFacts(secret: string): ErrandAddress | undefined {
  const parsed = parseAddressPayload(secret);
  if (!parsed) return undefined;
  return {
    recipientName: parsed.recipientName,
    line1: parsed.line1,
    ...(parsed.line2 ? { line2: parsed.line2 } : {}),
    city: parsed.city,
    ...(parsed.region ? { region: parsed.region } : {}),
    ...(parsed.postalCode ? { postalCode: parsed.postalCode } : {}),
    countryCode: parsed.countryCode,
  };
}

/**
 * The non-secret facts for `phone`. Returns a (possibly empty) object, never
 * throws. `deps` exists so the check script can exercise the shape without a
 * Convex deployment — same pattern as `agent/lib/vault-login.ts`.
 */
export async function loadErrandFacts(
  phone: string,
  deps: ErrandContextDeps = defaultDeps,
  opts?: { now?: Date },
): Promise<ErrandFacts> {
  // One round trip each, in parallel: this sits directly in front of a Cloud
  // run start, and two sequential Convex hops would be two hops of latency
  // before the browser even opens.
  //
  // The third read used to be the curated memo lines (≤6 of them, into
  // «помню: …»). That store is gone and its replacement, Supermemory, is
  // semantic search over a person's chat history — not a short list of vetted
  // facts, and nothing an errand brief can paste in blind without turning a
  // half-remembered sentence into an instruction the browser acts on. So the
  // feed is dropped rather than repointed: the brief runs on what the vault
  // actually holds — address, contact, timezone, today's date — which is what
  // the «НУЖНО: address» incident was about in the first place.
  const [tenant, items] = await Promise.all([
    safe("tenant", () => deps.getTenant(phone)),
    safe("vault list", () => deps.listVaultItems(phone)),
  ]);

  const facts: ErrandFacts = {};

  const displayName = tenant?.displayName?.trim();
  if (displayName) facts.displayName = displayName;

  const tz = resolveTenantTz(tenant?.tz);
  const nowLocal = formatLocalNow(tz, opts?.now ?? new Date());
  if (nowLocal) {
    facts.tz = tz;
    facts.nowLocal = nowLocal;
  }

  // Only `address` and `contact` are ever read. The filter is the security
  // boundary, so it is spelled out here rather than inferred downstream.
  const wanted = (items ?? []).filter(
    (item) => item.available && (item.kind === "address" || item.kind === "contact"),
  );
  // In parallel, like the two reads above. `readVaultSecret` is an ACTION,
  // and each one costs several internal hops plus a decrypt — awaiting them
  // one at a time put ~0.5s of dead time in front of every errand start, on
  // top of the brief budget. Order still decides who wins a duplicate field,
  // so the results are consumed in the original order, not as they land.
  const records = await Promise.all(
    wanted.map((item) =>
      safe("vault read", () => deps.readVaultSecret(phone, item.handle)),
    ),
  );
  for (const record of records) {
    if (!record?.secret) continue;
    if (record.kind === "address") {
      if (!facts.address) {
        const address = addressFacts(record.secret);
        if (address) facts.address = address;
      }
      continue;
    }
    if (record.kind !== "contact") continue;
    const contact = parseContactPayload(record.secret);
    if (!contact) continue;
    if (!facts.contactName && contact.fullName) facts.contactName = contact.fullName;
    if (!facts.phone && contact.phone) facts.phone = contact.phone;
    if (!facts.email && contact.email) facts.email = contact.email;
  }

  return facts;
}

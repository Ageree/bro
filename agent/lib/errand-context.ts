/**
 * What Bro already knows, gathered for ONE browser errand.
 *
 * WHY a separate loader. The Cloud errand lane never read the `address` and
 * `contact` vault kinds at all — `browser_task.ts` filters the vault to
 * `kind === "payment"` and `vault-login.ts` picks `login`, so the two kinds
 * that hold the human's street, name, phone and email were only ever used by
 * the Kernel worker's autofill subagent. Curated memories, the tenant's
 * timezone and their display name never reached a run either. The result was
 * a run that aborted with «НУЖНО: address» for an address sitting in the
 * vault two function calls away.
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
import { getTenant, listVaultItems, readVaultSecret, wakeLines } from "./convex.ts";
import { MEMORY_LINE_LIMIT, type ErrandAddress, type ErrandFacts } from "./errand-brief.ts";

export type ErrandContextDeps = {
  getTenant: typeof getTenant;
  listVaultItems: typeof listVaultItems;
  readVaultSecret: typeof readVaultSecret;
  wakeLines: typeof wakeLines;
};

const defaultDeps: ErrandContextDeps = {
  getTenant,
  listVaultItems,
  readVaultSecret,
  wakeLines,
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
  // run start, and three sequential Convex hops would be three hops of
  // latency before the browser even opens.
  const [tenant, items, memories] = await Promise.all([
    safe("tenant", () => deps.getTenant(phone)),
    safe("vault list", () => deps.listVaultItems(phone)),
    safe("memories", () => deps.wakeLines(phone)),
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
  for (const item of wanted) {
    const record = await safe("vault read", () => deps.readVaultSecret(phone, item.handle));
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

  const lines = (memories ?? [])
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MEMORY_LINE_LIMIT);
  if (lines.length > 0) facts.memories = lines;

  return facts;
}

import { generateText, Output } from "ai";
import * as z from "zod";
import { directModelSelection } from "@agent/lib/model/direct";
import { readBrowserVmSiteDirectly } from "@agent/lib/browser-vm/runs";
import type { BrowserVmSiteRead } from "@agent/lib/browser-vm/worker";
import {
  deleteBrowserSiteOperation,
  listBrowserSiteOperations,
  saveBrowserSiteOperation,
} from "@db/services/browser-site-operations";
import { getWorkspaceModelId } from "@db/services/settings";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import { directModelActive } from "@shared/model/provider";
import { knownSiteOperations } from "./known";
import {
  type SiteOperation,
  siteOperationHost,
  siteOperationSchema,
  siteReadFit,
  widenedSiteOperation,
  withTemplateKeys,
} from "./operation";
import { noteSiteOperationRead, siteOperationsFor } from "./run";

/**
 * Bro's own read of a site it has read before (BROWSER_SITE_API_WORKSPACES):
 * a search on a site with a known operation (`site-ops/`) is answered from
 * the site's own data in seconds, with no browser errand. The browser comes
 * first — an errand on the site lets the worker find the operation behind
 * its report — and every later search there goes through the operation:
 * a small model call fills the operation's results page from the errand
 * (`fillSiteRead`), the worker reads it in a tab of its own (`/v1/op`), and
 * `browser_task start` hands the results to the turn as its answer
 * (Pomerado's minted integration: deterministic at run time, the model only
 * picks the inputs). Anything else — no operation that fits, a fill that
 * names none, a site that turned the browser away or changed — goes on as
 * the errand it was: the browser does the search, and on a changed site it
 * finds the operation anew, which is the repair (`health.ts`).
 */
export function siteApiPilot(scope: { readonly workspaceId: string }) {
  const listed = env.BROWSER_SITE_API_WORKSPACES ?? [];
  return listed.includes("*") || listed.includes(scope.workspaceId);
}

const fillSchema = z.object({
  limit: z.number().nullable(),
  operation: z.string().nullable(),
  priceMax: z.number().nullable(),
  priceMin: z.number().nullable(),
  sort: z.enum(["price_asc", "price_desc", "site"]).nullable(),
  url: z.string().nullable(),
});

const fillInstructions = `You fill a website's results-page address for an errand. You get the errand, today's date, and the site's known results pages as templates: each %placeholder% in a template stands for a value the site writes there, and every other part of the address stays exactly as the template writes it — except a part of the path that names a place, a brand, a model or a category (a city such as kazan, a make such as toyota), which you write for this errand the way the site writes it in its addresses. Use the site's note for how it writes its values. Leave out a query key the errand gives no value for; never add a key the template does not have.
Answer {"operation": the name of the template you used or null, "url": the filled address or null, "sort": "price_asc", "price_desc" or "site" — the order the errand wants the results in, "priceMin" and "priceMax": the bounds of the price the errand names or null, "limit": how many results the errand asks for, or null}.
An errand to find, pick, choose, compare or show options is a search the templates are for. Answer operation null when no template fits the errand: it asks for another kind of page, for something to be booked, bought, sent or signed in to, or for a detail only an item's own page has. A price bound or a count the template has no key for is no reason for null: give it in priceMin, priceMax and limit. The words of a %query% are only what to search for, never the site's name or the errand's other conditions.`;

/**
 * Bro's errand as one of the site's results pages, by a small model call
 * with no reasoning (the judges' pattern, `askedToPay`): 1.4–3.2 s and
 * about 0.01 ₽ on the stand (25.10), and 11 errands of 11 filled right or
 * left for the browser (a booking, a vacancy's own page). Undefined on any
 * failure: the errand goes on as one.
 */
async function fillSiteRead(
  scope: AccessScope,
  input: {
    readonly errand: string;
    readonly note: string | undefined;
    readonly operations: readonly SiteOperation[];
  }
) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: await readWorkspaceTimeZone(scope),
  }).format(new Date());
  const modelId = await getWorkspaceModelId(scope);
  const selection = directModelActive()
    ? directModelSelection(modelId, { reasoningOff: true, toolChoice: "none" })
    : null;
  const { output } = await generateText({
    abortSignal: AbortSignal.timeout(fillTimeoutMs),
    instructions: fillInstructions,
    maxOutputTokens: 300,
    model: selection?.model ?? modelId,
    output: Output.object({ schema: fillSchema }),
    prompt: JSON.stringify({
      errand: input.errand,
      siteNote: input.note ?? null,
      templates: input.operations.map((operation) => ({
        about: operation.about ?? null,
        name: operation.name,
        page: operation.page,
      })),
      today,
    }),
    providerOptions: selection?.modelOptions.providerOptions,
  });
  return output;
}

const fillTimeoutMs = 8_000;

/** A search answered from a site's data counts as one for this long: the next start on it opens the site. */
const servedForMs = 10 * 60_000;
/** Who read which site directly, by session and host: a second start there wants what the read did not give. */
const served = new Map<string, number>();

function servedKey(sessionId: string, address: string) {
  const host = URL.parse(address)?.hostname.replace(/^www\./u, "") ?? "";
  return `${sessionId}|${host}`;
}

function servedRecently(sessionId: string, site: string, now: number) {
  for (const [key, at] of served) {
    if (now - at > servedForMs) served.delete(key);
  }
  return served.has(servedKey(sessionId, site));
}

/** What the turn gets in place of an errand's start: the site's results that fit the errand. */
export interface SiteDirectRead {
  readonly cards: Extract<BrowserVmSiteRead, { ok: true }>["cards"];
  readonly count: number;
  readonly url: string;
}

/**
 * The errand answered from the site's own data, or undefined for the errand
 * to go on in the browser. Only a search: the caller starts here for an
 * errand with nothing to submit, pay, stage or sign up for, in the
 * person's own turn.
 */
export async function readSiteDirectly(
  scope: AccessScope,
  input: Parameters<typeof readSite>[1]
): Promise<SiteDirectRead | undefined> {
  // The errand never fails for its fast path: whatever went wrong, it goes
  // on as it would have.
  return readSite(scope, input).catch((cause: unknown) => {
    console.warn("[site-api] the read failed", {
      name: cause instanceof Error ? cause.name : "unknown",
      workspaceId: scope.workspaceId,
    });
    return undefined;
  });
}

async function readSite(
  scope: AccessScope,
  input: {
    readonly errand: string;
    readonly note: string | undefined;
    readonly sessionId: string;
    readonly site: string;
  }
): Promise<SiteDirectRead | undefined> {
  const began = Date.now();
  if (servedRecently(input.sessionId, input.site, began)) return undefined;
  const operations = await siteOperationsFor(scope.workspaceId, input.site);
  if (operations.length === 0) return undefined;
  const fill = await fillSiteRead(scope, { ...input, operations }).catch(
    (cause: unknown) => {
      console.warn("[site-api] the errand was not filled", {
        name: cause instanceof Error ? cause.name : "unknown",
      });
      return undefined;
    }
  );
  const operation = operations.find(({ name }) => name === fill?.operation);
  const filled = fill?.url ?? undefined;
  const url =
    operation === undefined || filled === undefined
      ? undefined
      : withTemplateKeys(operation, filled);
  const fit =
    operation === undefined || url === undefined
      ? undefined
      : siteReadFit(operation, url);
  const fillMs = Date.now() - began;
  if (operation === undefined || url === undefined || fit === undefined) {
    console.info("[site-api] left to the browser", {
      fillMs,
      reason: operation === undefined ? "no_operation" : "address",
      workspaceId: scope.workspaceId,
    });
    return undefined;
  }
  const read = await readBrowserVmSiteDirectly(scope.workspaceId, {
    limit: Math.max(1, Math.min(Math.round(fill?.limit ?? 10) * 2, 30)),
    operation,
    priceMax: fill?.priceMax ?? null,
    priceMin: fill?.priceMin ?? null,
    sort: fill?.sort ?? "site",
    url,
  }).catch((cause: unknown) => {
    console.warn("[site-api] the read did not go through", {
      name: cause instanceof Error ? cause.name : "unknown",
      operation: operation.name,
    });
    return undefined;
  });
  const timing = {
    fillMs,
    fit,
    operation: operation.name,
    readMs: Date.now() - began - fillMs,
    workspaceId: scope.workspaceId,
  };
  if (read === undefined) return undefined;
  if (!read.ok) {
    console.info("[site-api] left to the browser", {
      ...timing,
      reason: read.reason,
    });
    await noteSiteOperationRead(scope.workspaceId, operation.name, {
      fit: read.fit,
      ok: false,
      reason: read.reason,
    });
    return undefined;
  }
  console.info("[site-api] served", {
    ...timing,
    cards: read.cards.length,
    count: read.count,
    via: read.via,
    workerMs: read.ms,
  });
  served.set(servedKey(input.sessionId, url), Date.now());
  await noteSiteOperationRead(scope.workspaceId, operation.name, {
    direct: true,
    ok: true,
  });
  if (read.fit === "loose") await widen(scope.workspaceId, operation, url);
  return { cards: read.cards, count: read.count, url };
}

/**
 * A workspace's own operation that read a page its template held otherwise
 * kept as the broader one (`widenedSiteOperation`), in place of the
 * narrower: the next errand on another city or car fits it exactly. A
 * reviewed operation is a person's, and stays as it was written.
 */
async function widen(
  workspaceId: string,
  operation: SiteOperation,
  url: string
) {
  if (knownSiteOperations.some(({ name }) => name === operation.name)) return;
  const wider = widenedSiteOperation(operation, url);
  if (wider === undefined || wider.name === operation.name) return;
  const rows = await listBrowserSiteOperations(workspaceId);
  const row = rows.find(({ name }) => name === operation.name);
  if (
    row === undefined ||
    !siteOperationSchema.safeParse(row.operation).success
  ) {
    return;
  }
  await saveBrowserSiteOperation(workspaceId, {
    host: siteOperationHost(wider.page),
    name: wider.name,
    operation: wider,
    runs: row.runs,
  });
  await deleteBrowserSiteOperation(workspaceId, operation.name);
  console.info("[site-ops] widened", { name: wider.name, workspaceId });
}

/**
 * The note of a start answered from the site's own data: what the turn does
 * with the results, in the first person as with any errand of Bro's.
 */
export function siteReadNote(read: SiteDirectRead) {
  return `These are the site's own results for its results page ${read.url}, read just now from the site's data (${String(read.count)} on the page; below, the ones that fit the errand, in the order it asks for). They are what the site shows now: each link is the result's own address on the site and counts as seen there. Answer the person from them in this turn — the options that fit the errand, each with its link, in the first person as when you look on the site yourself, never about an API, a browser or a run. When they cannot answer it — it needs what only the site's pages show, or none of them fits — call browser_task start again with the same site: that one goes through the site's pages.`;
}

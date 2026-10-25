import {
  deleteBrowserSiteOperation,
  dropBrokenBrowserSiteOperations,
  listBrowserSiteOperations,
  noteBrowserSiteOperationRead,
  saveBrowserSiteOperation,
} from "@db/services/browser-site-operations";
import { env } from "@shared/environment";
import { brokenAfter, readCounts, siteOperationUsable } from "./health";
import { knownSiteOperations } from "./known";
import type * as z from "zod";
import {
  type foundSiteOperationsSchema,
  mergeSiteOperations,
  type siteOperationCallsSchema,
  siteOperationHost,
  siteOperationOnSite,
  siteOperationSchema,
  type SiteOperation,
} from "./operation";

/** The operations one run is given: a site rarely has more than one results page that matters. */
const operationsPerRun = 3;

/** The runs whose finds this process has kept, the latest few hundred. */
const rememberedRuns = new Set<string>();
const rememberedRunsKept = 500;

/**
 * Whether the workspace is in the pilot (BROWSER_SITE_OPS_WORKSPACES:
 * workspace ids or `*`). Ids only, as BROWSER_HELIUM_WORKSPACES: nothing is
 * looked up at a run's start.
 */
export function siteOpsPilot(scope: { readonly workspaceId: string }) {
  const listed = env.BROWSER_SITE_OPS_WORKSPACES ?? [];
  return listed.includes("*") || listed.includes(scope.workspaceId);
}

/** The errand's site, from the task's `Site:` line (`composeBrowserTask`). */
export function errandSite(task: string) {
  return /^Site: (https:\/\/\S+)$/mu.exec(task)?.[1];
}

/**
 * The site's operations a run of the workspace gets: the reviewed ones
 * every workspace gets (`knownSiteOperations`) first, then its own finds,
 * the most often found first, each only while it still reads its site
 * (`siteOperationUsable`). On a host a reviewed operation covers, the
 * workspace's own finds are left out: a run's find of the same page (hh.ru,
 * found again while op() reads it) has no reviewer's words about its fields
 * (`about`), and would read in their place — unless the reviewed one
 * stopped reading the site for this workspace, and its find is the repair.
 */
export async function siteOperationsFor(
  workspaceId: string,
  site: string | undefined,
  now = new Date()
): Promise<SiteOperation[]> {
  if (site === undefined) return [];
  const rows = await listBrowserSiteOperations(workspaceId);
  const health = new Map(rows.map((row) => [row.name, row]));
  const usable = (operation: SiteOperation) =>
    siteOperationUsable(health.get(operation.name), now);
  const onSite = knownSiteOperations.filter((operation) =>
    siteOperationOnSite(operation, site)
  );
  const reviewed = new Set(
    knownSiteOperations.map((operation) => operation.name)
  );
  const known = onSite
    .filter(usable)
    .map((operation) => standingIn(operation, health.get(operation.name)));
  const reviewedHosts = new Set(
    known.map((operation) => siteOperationHost(operation.page))
  );
  const own = rows.flatMap((row) => {
    const parsed = siteOperationSchema.safeParse(row.operation);
    if (!parsed.success) return [];
    const operation = parsed.data;
    return siteOperationOnSite(operation, site) &&
      !reviewed.has(operation.name) &&
      !reviewedHosts.has(siteOperationHost(operation.page)) &&
      usable(operation)
      ? [operation]
      : [];
  });
  return [...known, ...own].slice(0, operationsPerRun);
}

/**
 * Whether a run's find of a reviewed operation's page is kept in its row
 * (`rememberSiteOperations`): the reviewed one stopped reading the site for
 * the workspace, or a find already stands in for it there.
 */
function repairs(
  row: { readonly failures: number; readonly runs: number } | undefined
) {
  return row !== undefined && (row.runs > 0 || row.failures >= brokenAfter);
}

/**
 * The operation a workspace reads a reviewed one's page with: the run's
 * find kept in its row once the reviewed one stopped reading the site
 * (`repairs`), the reviewer's words about the fields only while the find
 * reads them where the reviewed one did; otherwise the reviewed one.
 */
function standingIn(
  known: SiteOperation,
  row: { readonly operation: unknown; readonly runs: number } | undefined
): SiteOperation {
  if (row === undefined || row.runs === 0) return known;
  const find = siteOperationSchema.safeParse(row.operation).data;
  if (find === undefined) return known;
  const same =
    JSON.stringify([find.items, find.fields]) ===
    JSON.stringify([known.items, known.fields]);
  return { ...find, about: same ? known.about : undefined };
}

/**
 * An operation of the workspace's by its name, its own find or a reviewed
 * one, for a read of it to be noted against (`noteSiteOperationRead`).
 */
async function operationNamed(workspaceId: string, name: string) {
  const known = knownSiteOperations.find(
    (operation) => operation.name === name
  );
  if (known !== undefined) return known;
  const rows = await listBrowserSiteOperations(workspaceId);
  const row = rows.find((candidate) => candidate.name === name);
  return row === undefined
    ? undefined
    : siteOperationSchema.safeParse(row.operation).data;
}

/**
 * How a read of an operation went, kept with it (`health.ts`): results end
 * its failures; a failure that says the site changed adds one; any other
 * failure leaves it as it was.
 */
export async function noteSiteOperationRead(
  workspaceId: string,
  name: string,
  outcome:
    | { readonly direct: boolean; readonly ok: true }
    | {
        readonly fit: "exact" | "loose";
        readonly ok: false;
        readonly reason: Parameters<typeof readCounts>[0];
      }
) {
  if (!outcome.ok && !readCounts(outcome.reason, outcome.fit)) return;
  const operation = await operationNamed(workspaceId, name);
  if (operation === undefined) return;
  await noteBrowserSiteOperationRead(
    workspaceId,
    {
      host: siteOperationHost(operation.page),
      name: operation.name,
      operation,
      reviewed: knownSiteOperations.some(({ name: known }) => known === name),
    },
    outcome.ok
      ? { direct: outcome.direct, ok: true }
      : { ok: false, reason: outcome.reason }
  );
  if (!outcome.ok) {
    console.info("[site-ops] a read failed", {
      name: operation.name,
      reason: outcome.reason,
      workspaceId,
    });
  }
}

/** How a settled run's op() calls went (`siteTraffic.opCalls`), kept with their operations. */
async function noteSiteOperationCalls(
  workspaceId: string,
  calls: z.infer<typeof siteOperationCallsSchema> | undefined
) {
  for (const call of calls ?? []) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- A run makes a call or two.
    await noteSiteOperationRead(
      workspaceId,
      call.name,
      call.ok
        ? { direct: false, ok: true }
        : { fit: call.fit, ok: false, reason: call.reason ?? "failed" }
    );
  }
}

/**
 * The task's line about them, for the code engine (`op` in
 * browser-vm/worker/worker.py): one call reads a results page's results
 * from the site's own data instead of the page.
 */
export function siteOperationsLine(operations: readonly SiteOperation[]) {
  if (operations.length === 0) return undefined;
  const each = operations.map((operation) => {
    const known = (["name", "price", "link"] as const).filter(
      (role) => operation.fields[role] !== undefined
    );
    const about = operation.about === undefined ? "" : `; ${operation.about}`;
    return `op(${JSON.stringify(operation.name)}, url) for a results page like ${operation.page} (cards with ${[...known, "more"].join(", ")}${about})`;
  });
  return `Known operations of this site, read in one call from the site's own data: ${each.join("; ")}. op(name, url) opens url — that results page, each %placeholder% filled from the errand the way the site writes it in its addresses — and returns {cards, count}: every result the page has, in the site's order, each card with its name, price and link where known and \`more\`, the result's other fields keyed by their dotted paths (more["company.name"]). Call it first instead of goto() and cards(), then filter, sort and pick in your own code: most errands are that one call and then \`done\`. The cards are the site's own data for that page, and a card's link is the result's own address as the site gives it: it counts as observed, as a link read off the page does, so do not open the results' pages to check them; open one only for a detail the errand names that neither its card nor \`more\` has. op() leaves the tab on that results page, so the picture is of it. If op() fails, go on with the page as usual.`;
}

/**
 * What a settled run found (`siteTraffic.operations` of the worker's
 * record), kept for its workspace. Each record goes through the schema
 * first: one with a value, a header, a cookie or any key the schema does
 * not know is dropped, not cleaned. A find that differs from a kept one
 * only in a part of the page's path replaces it with one that has a
 * placeholder there (`mergeSiteOperations`).
 */
export async function rememberSiteOperations(
  workspaceId: string,
  found: z.infer<typeof foundSiteOperationsSchema> | undefined,
  runId?: string,
  calls?: z.infer<typeof siteOperationCallsSchema>
) {
  if ((found ?? []).length === 0 && (calls ?? []).length === 0) return;
  if (!siteOpsPilot({ workspaceId })) return;
  // Two reads that both saw the run settle (the tick and a status) count its
  // finds once. In the process only: the settle itself is not a claim.
  if (runId !== undefined) {
    if (rememberedRuns.has(runId)) return;
    rememberedRuns.add(runId);
    if (rememberedRuns.size > rememberedRunsKept) {
      rememberedRuns.delete(rememberedRuns.values().next().value ?? runId);
    }
  }
  // How its op() calls went first: a find of the same run is newer news.
  await noteSiteOperationCalls(workspaceId, calls);
  if (found === undefined || found.length === 0) return;
  const reviewed = new Set(
    knownSiteOperations.map((operation) => operation.name)
  );
  const rows = await listBrowserSiteOperations(workspaceId);
  const operations = found.flatMap((record) => {
    const parsed = siteOperationSchema.safeParse(record);
    if (!parsed.success) {
      console.warn("[site-ops] a found operation was refused", {
        issues: parsed.error.issues.map((issue) => issue.message).slice(0, 3),
      });
    }
    // A reviewed operation's page found again is the reviewed one's: it is
    // not kept beside it — unless the reviewed one stopped reading the site
    // for the workspace, or a find already stands in for it there: then
    // the find is the repair, kept in its row (`standingIn`).
    if (
      !parsed.success ||
      (reviewed.has(parsed.data.name) &&
        !repairs(rows.find(({ name }) => name === parsed.data.name)))
    ) {
      return [];
    }
    // Words about the fields are a reviewer's, never a run's: text a page
    // could have put there would go into the next errand's task.
    return [{ ...parsed.data, about: undefined }];
  });
  if (operations.length === 0) return;
  for (const operation of operations.slice(0, operationsPerRun)) {
    let kept: SiteOperation = operation;
    let runs = 1;
    for (const row of reviewed.has(operation.name) ? [] : rows) {
      const parsed = siteOperationSchema.safeParse(row.operation);
      // A reviewed operation's row is its health, not a find to merge.
      if (
        !parsed.success ||
        row.name === operation.name ||
        reviewed.has(row.name)
      ) {
        continue;
      }
      const merged = mergeSiteOperations(parsed.data, operation);
      if (merged !== undefined) {
        kept = merged;
        runs += row.runs;
        // oxlint-disable-next-line eslint/no-await-in-loop -- One narrower find replaced at a time.
        await deleteBrowserSiteOperation(workspaceId, row.name);
        break;
      }
    }
    if (reviewed.has(kept.name) && kept.name !== operation.name) continue;
    // oxlint-disable-next-line eslint/no-await-in-loop -- A run finds one or two.
    await saveBrowserSiteOperation(workspaceId, {
      host: siteOperationHost(kept.page),
      name: kept.name,
      operation: kept,
      runs,
    });
    // The repair: the host's operations that stopped reading it give way to
    // the one this run found.
    // oxlint-disable-next-line eslint/no-await-in-loop -- A run finds one or two.
    await dropBrokenBrowserSiteOperations(
      workspaceId,
      siteOperationHost(kept.page),
      brokenAfter,
      [kept.name, ...reviewed]
    );
    console.info("[site-ops] kept", {
      name: kept.name,
      source: kept.source.kind,
      workspaceId,
    });
  }
}

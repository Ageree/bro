import {
  deleteBrowserSiteOperation,
  dropBrokenBrowserSiteOperations,
  listBrowserSiteOperations,
  listSharedBrowserSiteOperations,
  noteBrowserSiteOperationRead,
  saveBrowserSiteOperation,
} from "@db/services/browser-site-operations";
import { env } from "@shared/environment";
import { brokenAfter, readCounts, siteOperationUsable } from "./health";
import { knownSiteOperations } from "./known";
import type * as z from "zod";
import {
  type foundSiteOperationsSchema,
  mergeSiteInputs,
  mergeSiteOperations,
  type siteOperationCallsSchema,
  sameSiteHost,
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

/**
 * Whether the workspace also gets the operations other workspaces' runs
 * found (BROWSER_SITE_SHARED_WORKSPACES: ids or `*`, inside the pilot
 * above). Pomerado's library is one for everybody: a site learned by others
 * is fast for the next person too. An operation is a site's results page as
 * a template and where its data lie — the schema keeps every value of an
 * errand out of it (`operation.ts`) —, the workspace reads it with its own
 * browser, and it is shared only once runs of two workspaces found it apart
 * on the very host the errand names (`listSharedBrowserSiteOperations`): a
 * page one person alone sees, as a company's own subdomain or a user's own
 * path, is never found the same by another.
 */
function siteSharedPilot(scope: { readonly workspaceId: string }) {
  const listed = env.BROWSER_SITE_SHARED_WORKSPACES ?? [];
  return (
    (listed.includes("*") || listed.includes(scope.workspaceId)) &&
    siteOpsPilot(scope)
  );
}

/**
 * Other workspaces' operations the workspace may get (`siteSharedPilot`),
 * by the site's host or by one name, each through the schema again. A
 * reviewed operation is every workspace's already.
 */
async function sharedOperations(
  workspaceId: string,
  where: { readonly host: string } | { readonly name: string }
) {
  if (!siteSharedPilot({ workspaceId })) return [];
  const reviewed = new Set(knownSiteOperations.map(({ name }) => name));
  const rows = await listSharedBrowserSiteOperations(
    workspaceId,
    where,
    brokenAfter
  );
  return rows.flatMap((row) => {
    const parsed = siteOperationSchema.safeParse(row.operation);
    return parsed.success && !reviewed.has(parsed.data.name)
      ? [{ ...parsed.data, about: undefined }]
      : [];
  });
}

/** A host as one site, its leading `www.` aside. */
function bareHost(host: string) {
  return host.toLowerCase().replace(/^www\./u, "");
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
 * Last, while there is room and the workspace reads nothing of its own on
 * the errand's very host, other workspaces' operations there
 * (`siteSharedPilot`), never one the workspace keeps a row of: its own
 * copy, or its own health of it, is what it reads by.
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
      ![...reviewedHosts].some((host) =>
        sameSiteHost(host, siteOperationHost(operation.page))
      ) &&
      usable(operation)
      ? [operation]
      : [];
  });
  const given = [...known, ...own];
  const host = bareHost(URL.parse(site)?.hostname ?? "");
  if (
    given.length >= operationsPerRun ||
    host === "" ||
    given.some(({ page }) => bareHost(siteOperationHost(page)) === host)
  ) {
    return given.slice(0, operationsPerRun);
  }
  const shared = (await sharedOperations(workspaceId, { host })).filter(
    (operation) =>
      bareHost(siteOperationHost(operation.page)) === host &&
      !health.has(operation.name)
  );
  if (shared.length > 0) {
    console.info("[site-ops] shared", {
      names: shared.map(({ name }) => name).slice(0, operationsPerRun),
      workspaceId,
    });
  }
  return [...given, ...shared].slice(0, operationsPerRun);
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
  return {
    ...find,
    about: same ? known.about : undefined,
    // The reviewer's inputs were read back live: a find's learned ones only
    // fill in what they lack.
    inputs: mergeSiteInputs(find.inputs, known.inputs),
  };
}

/**
 * An operation of the workspace's by its name, for a read of it to be noted
 * against (`noteSiteOperationRead`): a reviewed one, its own row, or one
 * another workspace shared — the last two with no row of the workspace's
 * yet are `adopted`, and the note makes their row.
 */
async function operationNamed(workspaceId: string, name: string) {
  const known = knownSiteOperations.find(
    (operation) => operation.name === name
  );
  if (known !== undefined) return { adopted: true, operation: known };
  const rows = await listBrowserSiteOperations(workspaceId);
  const row = rows.find((candidate) => candidate.name === name);
  if (row !== undefined) {
    const operation = siteOperationSchema.safeParse(row.operation).data;
    return operation === undefined ? undefined : { adopted: false, operation };
  }
  const [shared] = await sharedOperations(workspaceId, { name });
  return shared === undefined
    ? undefined
    : { adopted: true, operation: shared };
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
  const named = await operationNamed(workspaceId, name);
  if (named === undefined) return;
  const { operation } = named;
  await noteBrowserSiteOperationRead(
    workspaceId,
    {
      adopted: named.adopted,
      host: siteOperationHost(operation.page),
      name: operation.name,
      operation,
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
  // A find the run read through op() came to it from the workspace's rows
  // or from another workspace's: a new row of it is not a find of its own.
  const called = new Set((calls ?? []).map(({ name }) => name));
  for (const operation of operations.slice(0, operationsPerRun)) {
    let kept: SiteOperation = operation;
    let runs = 1;
    let adopted = called.has(operation.name);
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
        adopted ||= row.adopted;
        // oxlint-disable-next-line eslint/no-await-in-loop -- One narrower find replaced at a time.
        await deleteBrowserSiteOperation(workspaceId, row.name);
        break;
      }
    }
    if (reviewed.has(kept.name) && kept.name !== operation.name) continue;
    // What the site applies stays learned: a run that did not sort or bound
    // the price keeps what an earlier one learned of the page (`mergeSiteInputs`).
    const earlier = rows.find(({ name }) => name === kept.name);
    const before =
      earlier === undefined
        ? undefined
        : siteOperationSchema.safeParse(earlier.operation).data;
    if (before !== undefined) {
      kept = { ...kept, inputs: mergeSiteInputs(before.inputs, kept.inputs) };
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- A run finds one or two.
    await saveBrowserSiteOperation(workspaceId, {
      adopted,
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

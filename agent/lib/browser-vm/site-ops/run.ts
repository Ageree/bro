import {
  deleteBrowserSiteOperation,
  listBrowserSiteOperations,
  saveBrowserSiteOperation,
} from "@db/services/browser-site-operations";
import { env } from "@shared/environment";
import { knownSiteOperations } from "./known";
import type * as z from "zod";
import {
  type foundSiteOperationsSchema,
  mergeSiteOperations,
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
 * the most often found first. On a host a reviewed operation covers, the
 * workspace's own finds are left out: a run's find of the same page (hh.ru,
 * found again while op() reads it) has no reviewer's words about its fields
 * (`about`), and would read in their place.
 */
export async function siteOperationsFor(
  workspaceId: string,
  site: string | undefined
): Promise<SiteOperation[]> {
  if (site === undefined) return [];
  const known = knownSiteOperations.filter((operation) =>
    siteOperationOnSite(operation, site)
  );
  const reviewed = new Set(known.map((operation) => operation.name));
  const reviewedHosts = new Set(
    known.map((operation) => siteOperationHost(operation.page))
  );
  const rows = await listBrowserSiteOperations(workspaceId);
  const own = rows.flatMap((row) => {
    const parsed = siteOperationSchema.safeParse(row.operation);
    if (!parsed.success) return [];
    const operation = parsed.data;
    return siteOperationOnSite(operation, site) &&
      !reviewed.has(operation.name) &&
      !reviewedHosts.has(siteOperationHost(operation.page))
      ? [operation]
      : [];
  });
  return [...known, ...own].slice(0, operationsPerRun);
}

/**
 * The task's line about them, for the code engine (`op` in
 * browser-vm/worker/worker.py): one call reads a results page's results
 * from the site's own data instead of the page.
 */
/** How the task line of a site's known operations begins. */
export const siteOperationsLead =
  "Known operations of this site, read in one call from the site's own data:";

export function siteOperationsLine(operations: readonly SiteOperation[]) {
  if (operations.length === 0) return undefined;
  const each = operations.map((operation) => {
    const known = (["name", "price", "link"] as const).filter(
      (role) => operation.fields[role] !== undefined
    );
    const about = operation.about === undefined ? "" : `; ${operation.about}`;
    return `op(${JSON.stringify(operation.name)}, url) for a results page like ${operation.page} (cards with ${[...known, "more"].join(", ")}${about})`;
  });
  return `${siteOperationsLead} ${each.join("; ")}. op(name, url) opens url — that results page, each %placeholder% filled from the errand the way the site writes it in its addresses — and returns {cards, count}: every result the page has, in the site's order, each card with its name, price and link where known and \`more\`, the result's other fields keyed by their dotted paths (more["company.name"]). Call it first instead of goto() and cards(), then filter, sort and pick in your own code: most errands are that one call and then \`done\`. The cards are the site's own data for that page, and a card's link is the result's own address as the site gives it: it counts as observed, as a link read off the page does, so do not open the results' pages to check them; open one only for a detail the errand names that neither its card nor \`more\` has. op() leaves the tab on that results page, so the picture is of it. If op() fails, go on with the page as usual.`;
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
  runId?: string
) {
  if (found === undefined || found.length === 0) return;
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
  const reviewed = new Set(
    knownSiteOperations.map((operation) => operation.name)
  );
  const operations = found.flatMap((record) => {
    const parsed = siteOperationSchema.safeParse(record);
    if (!parsed.success) {
      console.warn("[site-ops] a found operation was refused", {
        issues: parsed.error.issues.map((issue) => issue.message).slice(0, 3),
      });
    }
    // A reviewed operation's page found again is the reviewed one's: it is
    // not kept beside it.
    if (!parsed.success || reviewed.has(parsed.data.name)) return [];
    // Words about the fields are a reviewer's, never a run's: text a page
    // could have put there would go into the next errand's task.
    return [{ ...parsed.data, about: undefined }];
  });
  if (operations.length === 0) return;
  const rows = await listBrowserSiteOperations(workspaceId);
  for (const operation of operations.slice(0, operationsPerRun)) {
    let kept: SiteOperation = operation;
    let runs = 1;
    for (const row of rows) {
      const parsed = siteOperationSchema.safeParse(row.operation);
      if (!parsed.success || row.name === operation.name) continue;
      const merged = mergeSiteOperations(parsed.data, operation);
      if (merged !== undefined) {
        kept = merged;
        runs += row.runs;
        // oxlint-disable-next-line eslint/no-await-in-loop -- One narrower find replaced at a time.
        await deleteBrowserSiteOperation(workspaceId, row.name);
        break;
      }
    }
    if (reviewed.has(kept.name)) continue;
    // oxlint-disable-next-line eslint/no-await-in-loop -- A run finds one or two.
    await saveBrowserSiteOperation(workspaceId, {
      host: siteOperationHost(kept.page),
      name: kept.name,
      operation: kept,
      runs,
    });
    console.info("[site-ops] kept", {
      name: kept.name,
      source: kept.source.kind,
      workspaceId,
    });
  }
}

import type { SiteReadFailure } from "./operation";

/**
 * Whether a site's operation still reads its site, by how its reads went
 * (`failures` of `browser_site_operations`). The repair is the browser's:
 * an operation that stopped reading its site is not offered — neither to
 * Bro's own read (`direct.ts`) nor to a run's op() — and its site's next
 * errand goes through the page, where the worker finds the operation anew
 * (`rememberSiteOperations`), which ends the failures or replaces it.
 *
 * Only a read whose page fitted the template exactly counts, and only
 * when the site itself answered otherwise than before (Pomerado's outcome
 * classes, docs: a challenge or a host problem «does not count against the
 * tool»): `blocked` is the site's anti-bot or the exit, `empty` a search
 * with nothing, and a `loose` page may be the fill's own mistake.
 */
export const brokenAfter = 2;

/**
 * How long a broken operation rests before one read tries it again: a site
 * that was down, or a page that was slow through its exit, gets its
 * operation back without a run.
 */
const retryBrokenAfterMs = 6 * 60 * 60_000;

export function readCounts(reason: SiteReadFailure, fit: "exact" | "loose") {
  return (
    fit === "exact" &&
    (reason === "moved" || reason === "no_data" || reason === "failed")
  );
}

export function siteOperationUsable(
  health:
    | { readonly failedAt: Date | null; readonly failures: number }
    | undefined,
  now: Date
) {
  if (health === undefined || health.failures < brokenAfter) return true;
  return (
    health.failedAt === null ||
    now.getTime() - health.failedAt.getTime() > retryBrokenAfterMs
  );
}

/**
 * A worker that crashes between `manage_browsers create` and `delete` never
 * calls `browsers.drop`: the Convex bookkeeping row lingers forever, and —
 * unless Kernel polices idle sessions on its own — so does the real Kernel
 * browser, billing until its own `timeout_seconds` elapses (up to 3 days).
 * `browsersGc.sweep` (a 30-minute cron) uses this predicate to find rows old
 * enough that no real worker session is still using them.
 */

export const STALE_BROWSER_SESSION_MS = 3 * 60 * 60 * 1000; // 3h

export function isStaleBrowserSession(
  row: { createdAt: number },
  nowMs: number,
): boolean {
  return nowMs - row.createdAt > STALE_BROWSER_SESSION_MS;
}

import { listsWorkspaceRemembered } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";

/**
 * Whether the workspace is in the pilot of the fast browser
 * (BROWSER_FAST_WORKSPACES, docs/browser-speed.md): its errands on its own
 * browser have DeepSeek served by Together first and give up on a call of
 * it stuck past `fastLlmTimeoutSeconds` (`runs.ts`), and run in flash mode
 * when they only search. The list names a workspace by its id or its
 * owner's email, as BROWSER_VM_WORKSPACES does, or everyone with `*`; unset,
 * nobody is, and nothing is looked up. A verdict by the email is remembered for ten
 * minutes: it is asked at every start, follow-up and retry of a queued
 * errand. A failed lookup runs the errand as before rather than failing its
 * start.
 */
export async function fastBrowserPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  return inPilot("browser-fast", env.BROWSER_FAST_WORKSPACES, scope);
}

/**
 * Whether the workspace's browser tries BROWSER_VM_PROXY_FALLBACK before
 * BROWSER_VM_PROXY (BROWSER_PROXY_FALLBACK_FIRST_WORKSPACES): the owner
 * tries the second provider on production this way first. The list reads
 * as BROWSER_FAST_WORKSPACES does, and a failed lookup keeps the usual order.
 */
export async function proxyFallbackFirstPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  return inPilot(
    "browser-proxy",
    env.BROWSER_PROXY_FALLBACK_FIRST_WORKSPACES,
    scope
  );
}

/**
 * Whether a run's report waits at most `reportPageWaitMs` for the picture of
 * its last page when the run saved no item photos
 * (BROWSER_REPORT_FAST_WORKSPACES, `agent/lib/browser-use/images.ts`). The
 * list reads as BROWSER_FAST_WORKSPACES does; a failed lookup waits as before.
 */
export async function reportFastPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  return inPilot("browser-report", env.BROWSER_REPORT_FAST_WORKSPACES, scope);
}

/**
 * The browser a workspace's errands ask for: Helium in the pilot
 * (BROWSER_HELIUM_WORKSPACES) — the same Chromium as Chrome there, with
 * uBlock Origin built in and none of Google's background downloads. The
 * worker switches to it once and remembers it in the profile
 * (`browser-vm/worker/worker.py`, `switch_browser`); a root without Helium
 * keeps Chrome. Chrome is asked for only on the canary root
 * (BROWSER_ROOTFS_CANARY_WORKSPACES), the one root with Helium, so that a
 * workspace taken out of the pilot goes back; everyone else's errands name
 * no browser and go to the worker byte for byte as before. Both lists name
 * workspace ids or `*`, never emails: a lookup that failed would switch the
 * browser, and the restart drops every session's pages.
 */
export function errandBrowser(scope: { readonly workspaceId: string }) {
  const listed = (entries: readonly string[] | undefined) =>
    entries?.includes("*") === true ||
    entries?.includes(scope.workspaceId) === true;
  if (listed(env.BROWSER_HELIUM_WORKSPACES)) return "helium" as const;
  return listed(env.BROWSER_ROOTFS_CANARY_WORKSPACES)
    ? ("chrome" as const)
    : undefined;
}

/**
 * The engine of a run (BROWSER_CODE_ENGINE_WORKSPACES): `code` for an errand
 * that only finds things (`findsOnly` in `createBrowserVmRun`: nothing to
 * submit, stage or pay, and no secret but a sign-in on its site) in the pilot, where the model writes code against the
 * page's accessibility tree and batches several steps in one call, the way
 * Aside's agent does (`run_code` in `browser-vm/worker/worker.py`). On the
 * worker's stand on 25.10 an hh.ru search took 97 s and 15 calls on it, as on
 * browser-use, at 1.67 ₽ against 7.13 ₽. A root without the engine, and a
 * worker before 2026-10-25.3, run it on browser-use. Every other errand names
 * no engine and goes to the worker as before; a failed lookup names none.
 */
export async function errandEngine(
  scope: { readonly userId?: string; readonly workspaceId: string },
  findsOnly: boolean
) {
  if (!findsOnly) return undefined;
  return (await inPilot(
    "browser-code",
    env.BROWSER_CODE_ENGINE_WORKSPACES,
    scope
  ))
    ? ("code" as const)
    : undefined;
}

/**
 * Whether the workspace's browser errands are reported the moment they end
 * (BROWSER_FAST_DELIVERY_WORKSPACES): the worker tells Bro when a run ends,
 * so that its report does not wait for Bro's next look. The list reads as BROWSER_FAST_WORKSPACES does; a failed lookup runs the errand as
 * before.
 */
export async function fastDeliveryPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  return inPilot(
    "browser-delivery",
    env.BROWSER_FAST_DELIVERY_WORKSPACES,
    scope
  );
}

async function inPilot(
  pilot: string,
  entries: readonly string[] | undefined,
  scope: { readonly userId?: string; readonly workspaceId: string }
) {
  const list = entries ?? [];
  if (list.length === 0) return false;
  if (list.includes("*")) return true;
  try {
    return await listsWorkspaceRemembered(list, scope);
  } catch (error) {
    console.warn(`[${pilot}] pilot lookup failed`, { cause: error });
    return false;
  }
}

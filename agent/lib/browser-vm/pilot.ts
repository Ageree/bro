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

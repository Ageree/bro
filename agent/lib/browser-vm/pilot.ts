import { listsWorkspace } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";

/**
 * Whether the workspace is in the pilot of the fast browser
 * (BROWSER_FAST_WORKSPACES, docs/browser-speed.md): its errands on its own
 * browser have DeepSeek served by Together first, give up on a model call
 * stuck past `fastLlmTimeoutSeconds`, and run in flash mode when they only
 * search. The list names a workspace by its id or its owner's email, as
 * BROWSER_VM_WORKSPACES does, or everyone with `*`; unset, nobody is, and
 * nothing is looked up. A failed lookup of the email runs the errand as
 * before rather than failing its start.
 */
export async function fastBrowserPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  const list = env.BROWSER_FAST_WORKSPACES ?? [];
  if (list.length === 0) return false;
  if (list.includes("*")) return true;
  try {
    return await listsWorkspace(list, scope);
  } catch (error) {
    console.warn("[browser-fast] pilot lookup failed", { cause: error });
    return false;
  }
}

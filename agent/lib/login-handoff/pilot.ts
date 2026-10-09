import { listsWorkspaceRemembered } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";

/**
 * Whether the workspace is in the pilot of the sign-in link
 * (LOGIN_HANDOFF_WORKSPACES, docs/login-handoff.md): its Bro may send a link
 * where the person signs in to a site themselves in a live view of their own
 * browser. The list names a workspace by its id or its owner's email, or
 * everyone with `*`; unset, nobody is, and nothing is looked up. A verdict by
 * email is remembered for ten minutes, and a failed lookup keeps the
 * workspace out for that call.
 */
export async function loginHandoffPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  const list = env.LOGIN_HANDOFF_WORKSPACES ?? [];
  if (list.length === 0) return false;
  if (list.includes("*")) return true;
  try {
    return await listsWorkspaceRemembered(list, scope);
  } catch (error) {
    console.warn("[login-handoff] pilot lookup failed", { cause: error });
    return false;
  }
}

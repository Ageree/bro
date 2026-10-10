import { listsWorkspaceRemembered } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";

/**
 * Whether the sign-in link (LOGIN_HANDOFF_WORKSPACES, docs/login-handoff.md)
 * is on at all: every workspace's Bro may send a link where the person signs
 * in to a site themselves in a live view of their own browser, unless the
 * flag says `off`.
 */
export function loginHandoffOn() {
  return !(env.LOGIN_HANDOFF_WORKSPACES ?? []).includes("off");
}

/**
 * Whether the workspace gets the sign-in link. Unset or empty, everyone
 * does; `off` switches it off for all; otherwise the list names a workspace
 * by its id or its owner's email, or everyone with `*`. A verdict by email is
 * remembered for ten minutes, and a failed lookup keeps the workspace out
 * for that call.
 */
export async function loginHandoffPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  if (!loginHandoffOn()) return false;
  const list = env.LOGIN_HANDOFF_WORKSPACES ?? [];
  if (list.length === 0 || list.includes("*")) return true;
  try {
    return await listsWorkspaceRemembered(list, scope);
  } catch (error) {
    console.warn("[login-handoff] pilot lookup failed", { cause: error });
    return false;
  }
}

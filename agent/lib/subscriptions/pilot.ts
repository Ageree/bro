import { listsWorkspaceRemembered } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";

/**
 * Whether a workspace's Bro may set up watches that code checks
 * (`watch-create`): the pilot named in SUBSCRIPTIONS_WORKSPACES by workspace
 * id or owner's email, or everyone with `*`. Every turn asks, so the verdict
 * by email is remembered for a while; a failed lookup keeps the workspace out
 * for that call.
 */
export async function subscriptionsPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  const list = env.SUBSCRIPTIONS_WORKSPACES ?? [];
  if (list.length === 0) return false;
  if (list.includes("*")) return true;
  try {
    return await listsWorkspaceRemembered(list, scope);
  } catch (error) {
    console.warn("[subscriptions] pilot lookup failed", { cause: error });
    return false;
  }
}

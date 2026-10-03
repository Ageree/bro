import { listsWorkspaceRemembered } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";

/**
 * Whether a workspace is in the pilot of one history across channels
 * (docs/roadmap.md, item 28): its chats log what was said, and a message in
 * one channel carries a recap of the others. CROSS_CHANNEL_WORKSPACES names
 * it by workspace id or owner's email, or everyone with `*`. A failed lookup
 * of the email keeps the workspace out: nothing is logged or recalled.
 */
export async function crossChannelPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  const list = env.CROSS_CHANNEL_WORKSPACES ?? [];
  if (list.length === 0) return false;
  if (list.includes("*")) return true;
  try {
    return await listsWorkspaceRemembered(list, scope);
  } catch (error) {
    console.warn("[cross-channel] pilot lookup failed", { cause: error });
    return false;
  }
}

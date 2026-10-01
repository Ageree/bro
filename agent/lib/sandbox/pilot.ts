import { directModelActive } from "@shared/model/provider";
import { listsWorkspaceRemembered } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";
import { sandboxHostConfigured } from "./host";

/**
 * Whether a workspace's Bro may hand jobs to the task agent
 * (`agent/subagents/task`): only with the code sandbox host configured, only
 * with the direct model, RouterAI or OpenRouter (the task agent's model is
 * resolved per step like Bro's), and only for the pilot named in
 * SANDBOX_WORKSPACES by workspace id or owner's email, or everyone with `*`. Every interactive
 * step asks, so the verdict by email is remembered for a while; a failed
 * lookup of the email keeps the workspace out for that call.
 */
export async function taskAgentPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  const list = env.SANDBOX_WORKSPACES ?? [];
  if (list.length === 0 || !sandboxHostConfigured() || !directModelActive()) {
    return false;
  }
  if (list.includes("*")) return true;
  try {
    return await listsWorkspaceRemembered(list, scope);
  } catch (error) {
    console.warn("[sandbox] pilot lookup failed", { cause: error });
    return false;
  }
}

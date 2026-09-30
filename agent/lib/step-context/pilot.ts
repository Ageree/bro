import { listsWorkspace } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";
import { openRouterActive } from "@shared/model/provider";

/**
 * Whether a workspace's steps are built for the prompt cache
 * (docs/agent-costs.md, 3.2): the notes of a step — the person's clock, the
 * reply directive and the rest — come after the history rather than in the
 * system part, and a browser report's turn keeps only its few tools once its
 * message is out. STEP_CONTEXT_WORKSPACES names the pilot by workspace id or
 * owner's email, as BROWSER_VM_WORKSPACES does, or everyone with `*`.
 *
 * Only the direct OpenRouter model carries step notes: a Gateway id would
 * lose the clock along with them, so there nobody is in the pilot.
 */
export async function stepContextPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  const list = env.STEP_CONTEXT_WORKSPACES ?? [];
  if (!openRouterActive() || list.length === 0) return false;
  return list.includes("*") || listsWorkspace(list, scope);
}

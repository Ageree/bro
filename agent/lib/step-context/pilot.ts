import { listsWorkspaceRemembered } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";
import { directModelActive } from "@shared/model/provider";

/**
 * Whether a workspace's steps are built for the prompt cache
 * (docs/agent-costs.md, 3.2): the notes of a step — the person's clock, the
 * reply directive and the rest — come after the history rather than in the
 * system part, and a browser report's turn keeps only its few tools once its
 * message is out. STEP_CONTEXT_WORKSPACES names the pilot by workspace id or
 * owner's email, as BROWSER_VM_WORKSPACES does, or everyone with `*`.
 *
 * Only the direct model (RouterAI or OpenRouter) carries step notes: a Gateway id would
 * lose the clock along with them, so there nobody is in the pilot. A failed
 * lookup of the email keeps the workspace out of the pilot for that call
 * rather than failing the step, and is not remembered.
 */
export async function stepContextPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  const list = env.STEP_CONTEXT_WORKSPACES ?? [];
  if (!directModelActive() || list.length === 0) return false;
  if (list.includes("*")) return true;
  try {
    // Every step asks, and the turn's instructions ask once more.
    return await listsWorkspaceRemembered(list, scope);
  } catch (error) {
    console.warn("[step-context] pilot lookup failed", { cause: error });
    return false;
  }
}

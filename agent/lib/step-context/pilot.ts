import { listsWorkspace } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";
import { openRouterActive } from "@shared/model/provider";

/**
 * How long a workspace's verdict by its owner's email holds. Every step asks,
 * and the turn's instructions ask once more: without it a pilot named by
 * email paid a lookup of the email at each of them.
 */
const verdictLifetimeMs = 10 * 60_000;

const verdicts = new Map<
  string,
  { readonly expiresAt: number; readonly listed: boolean }
>();

/**
 * Whether a workspace's steps are built for the prompt cache
 * (docs/agent-costs.md, 3.2): the notes of a step — the person's clock, the
 * reply directive and the rest — come after the history rather than in the
 * system part, and a browser report's turn keeps only its few tools once its
 * message is out. STEP_CONTEXT_WORKSPACES names the pilot by workspace id or
 * owner's email, as BROWSER_VM_WORKSPACES does, or everyone with `*`.
 *
 * Only the direct OpenRouter model carries step notes: a Gateway id would
 * lose the clock along with them, so there nobody is in the pilot. A failed
 * lookup of the email keeps the workspace out of the pilot for that call
 * rather than failing the step, and is not remembered.
 */
export async function stepContextPilot(scope: {
  readonly userId?: string;
  readonly workspaceId: string;
}) {
  const list = env.STEP_CONTEXT_WORKSPACES ?? [];
  if (!openRouterActive() || list.length === 0) return false;
  if (list.includes("*") || list.includes(scope.workspaceId)) return true;
  if (!list.some((entry) => entry.includes("@"))) return false;
  const now = Date.now();
  const known = verdicts.get(scope.workspaceId);
  if (known && known.expiresAt > now) return known.listed;
  try {
    const listed = await listsWorkspace(list, scope);
    verdicts.set(scope.workspaceId, {
      expiresAt: now + verdictLifetimeMs,
      listed,
    });
    return listed;
  } catch (error) {
    console.warn("[step-context] pilot lookup failed", { cause: error });
    return false;
  }
}

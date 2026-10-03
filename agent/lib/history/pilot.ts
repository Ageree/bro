import {
  listsWorkspaceRemembered,
  pilotVerdictOfTurn,
} from "@agent/lib/workspace-list";
import { env } from "@shared/environment";
import { directModelActive } from "@shared/model/provider";

/**
 * Whether a workspace's steps send old tool results as a short trace
 * (docs/roadmap.md, item 28; `trim.ts`). HISTORY_TRIM_WORKSPACES names the
 * pilot by workspace id or owner's email, as STEP_CONTEXT_WORKSPACES does,
 * or everyone with `*`.
 *
 * Only the direct model (RouterAI or OpenRouter) carries the trimming
 * middleware, so on the Gateway nobody is in the pilot. A failed lookup of
 * the email keeps the workspace out for that call rather than failing the
 * step. Asked with the step's `turn`, the verdict holds for the whole turn:
 * a pilot that flipped between steps would rewrite the history the turn's
 * earlier steps sent and break its prompt cache.
 */
export async function historyTrimPilot(
  scope: {
    readonly userId?: string;
    readonly workspaceId: string;
  },
  turn?: Parameters<typeof pilotVerdictOfTurn>[1]
) {
  const list = env.HISTORY_TRIM_WORKSPACES ?? [];
  if (!directModelActive() || list.length === 0) return false;
  if (list.includes("*")) return true;
  return pilotVerdictOfTurn("history-trim", turn, async () => {
    try {
      return await listsWorkspaceRemembered(list, scope);
    } catch (error) {
      console.warn("[history-trim] pilot lookup failed", { cause: error });
      return undefined;
    }
  });
}

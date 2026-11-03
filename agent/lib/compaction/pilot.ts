import {
  listsWorkspaceRemembered,
  pilotVerdictOfTurn,
} from "@agent/lib/workspace-list";
import { env } from "@shared/environment";
import { directModelActive } from "@shared/model/provider";

/**
 * Whether a workspace's long conversations are compacted at about
 * COMPACTION_INPUT_TOKENS of a step's whole input (docs/roadmap.md, item 28;
 * `window.ts`). COMPACTION_WORKSPACES names the pilot by workspace id or
 * owner's email, as HISTORY_TRIM_WORKSPACES does, or everyone with `*`.
 *
 * Only the direct model (RouterAI or OpenRouter) tells eve the window a step
 * compacts at, so on the Gateway nobody is in the pilot. A failed lookup of
 * the email keeps the workspace out for that call rather than failing the
 * step. Asked with the step's `turn`, the verdict holds for the whole turn.
 */
export async function compactionPilot(
  scope: {
    readonly userId?: string;
    readonly workspaceId: string;
  },
  turn?: Parameters<typeof pilotVerdictOfTurn>[1]
) {
  // Unset means everyone: a long chat otherwise grows to hundreds of
  // thousands of tokens a step (a Telegram session reached 388k, 05.11
  // costs); `off` is the way back.
  const list = env.COMPACTION_WORKSPACES ?? ["*"];
  if (!directModelActive() || list.length === 0 || list.includes("off")) {
    return false;
  }
  if (list.includes("*")) return true;
  return pilotVerdictOfTurn("compaction", turn, async () => {
    try {
      return await listsWorkspaceRemembered(list, scope);
    } catch (error) {
      console.warn("[compaction] pilot lookup failed", { cause: error });
      return undefined;
    }
  });
}

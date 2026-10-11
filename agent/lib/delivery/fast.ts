import {
  listsWorkspaceRemembered,
  pilotVerdictOfTurn,
} from "@agent/lib/workspace-list";
import { env } from "@shared/environment";
import { directModelActive } from "@shared/model/provider";

/**
 * Whether the steps of a workspace's turns run without hidden reasoning.
 * FAST_REPLY_WORKSPACES names the pilot by workspace id or owner's email, as
 * EARLY_REPLY_WORKSPACES does, or everyone with `*`.
 *
 * Every step of a person's turn runs in the one mode: DeepInfra caches a
 * prompt per reasoning mode, so a turn that switched between steps read the
 * switched step's whole prompt uncached.
 *
 * Only the direct model carries the switch, so on the Gateway nobody is in
 * the pilot. A failed lookup of the email keeps the workspace out for that
 * call. Asked with the step's `turn`, the verdict holds for the whole turn.
 */
export async function fastReplyPilot(
  scope: {
    readonly userId?: string;
    readonly workspaceId: string;
  },
  turn?: Parameters<typeof pilotVerdictOfTurn>[1]
) {
  const list = env.FAST_REPLY_WORKSPACES ?? [];
  if (!directModelActive() || list.length === 0) return false;
  if (list.includes("*")) return true;
  return pilotVerdictOfTurn("fast-reply", turn, async () => {
    try {
      return await listsWorkspaceRemembered(list, scope);
    } catch (error) {
      console.warn("[fast-reply] pilot lookup failed", { cause: error });
      return undefined;
    }
  });
}

import {
  listsWorkspaceRemembered,
  pilotVerdictOfTurn,
} from "@agent/lib/workspace-list";
import { env } from "@shared/environment";
import { directModelActive } from "@shared/model/provider";

interface Scope {
  readonly userId?: string;
  readonly workspaceId: string;
}
type Turn = Parameters<typeof pilotVerdictOfTurn>[1];

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
async function listed(
  pilot: string,
  list: readonly string[] | undefined,
  scope: Scope,
  turn: Turn
) {
  if (!directModelActive() || list === undefined || list.length === 0) {
    return false;
  }
  if (list.includes("*")) return true;
  return pilotVerdictOfTurn(pilot, turn, async () => {
    try {
      return await listsWorkspaceRemembered(list, scope);
    } catch (error) {
      console.warn(`[${pilot}] pilot lookup failed`, { cause: error });
      return undefined;
    }
  });
}

export function fastReplyPilot(scope: Scope, turn?: Turn) {
  return listed("fast-reply", env.FAST_REPLY_WORKSPACES, scope, turn);
}

/**
 * Whether the early-reply pilot's heads-up goes in a step of its own
 * (EARLY_REPLY_SPLIT_WORKSPACES, same format).
 */
export function earlyReplySplitPilot(scope: Scope, turn?: Turn) {
  return listed(
    "early-reply-split",
    env.EARLY_REPLY_SPLIT_WORKSPACES,
    scope,
    turn
  );
}

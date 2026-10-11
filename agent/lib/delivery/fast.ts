import type { ModelMessage } from "ai";
import {
  listsWorkspaceRemembered,
  pilotVerdictOfTurn,
} from "@agent/lib/workspace-list";
import { currentTurnMessages } from "@agent/lib/delivery/turn-sends";
import { env } from "@shared/environment";
import { directModelActive } from "@shared/model/provider";

interface Scope {
  readonly userId?: string;
  readonly workspaceId: string;
}
type Turn = Parameters<typeof pilotVerdictOfTurn>[1];

/**
 * Whether a workspace's answer steps run without hidden reasoning.
 * FAST_REPLY_WORKSPACES names the pilot by workspace id or owner's email, as
 * EARLY_REPLY_WORKSPACES does, or everyone with `*`;
 * FAST_FIRST_STEP_WORKSPACES, in the same format, extends it to the first
 * step of a person's turn.
 *
 * Only the direct model carries the switch, so on the Gateway nobody is in
 * the pilot. A failed lookup of the email keeps the workspace out for that
 * call. Asked with the step's `turn`, the verdict holds for the whole turn.
 * Reasoning is a request option, not a prompt change, but DeepInfra caches a
 * prompt per mode: the first off step after an idle hour reads uncached.
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

export function earlyReplySplitPilot(scope: Scope, turn?: Turn) {
  return listed(
    "early-reply-split",
    env.EARLY_REPLY_SPLIT_WORKSPACES,
    scope,
    turn
  );
}

export function fastFirstStepPilot(scope: Scope, turn?: Turn) {
  return listed("fast-first-step", env.FAST_FIRST_STEP_WORKSPACES, scope, turn);
}

/**
 * A step that only passes a result on: the turn has a tool's result. The
 * first step of a turn picks the tool and writes its arguments, so it keeps
 * its reasoning unless FAST_FIRST_STEP_WORKSPACES names the workspace.
 */
export function relaysToolResult(messages: readonly ModelMessage[]) {
  return currentTurnMessages(messages).some(
    (message) => message.role === "tool"
  );
}

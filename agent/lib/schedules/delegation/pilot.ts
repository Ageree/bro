import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { env } from "@shared/environment";

type ModeContext = Parameters<typeof resolveModeValue>[0];

/**
 * Whether a workspace's schedules may keep and do a free action the person
 * delegated (BACKGROUND_ACTIONS_WORKSPACES): ids only, or `*`, so the
 * verdict needs no lookup.
 */
export function backgroundActionsPilot(workspaceId: string) {
  const list = env.BACKGROUND_ACTIONS_WORKSPACES ?? [];
  return list.includes("*") || list.includes(workspaceId);
}

/** The workspace of this turn's caller, when it is a person's. */
function callerWorkspace(context: ModeContext) {
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") return undefined;
  return z.string().min(1).safeParse(caller.attributes.workspaceId).data;
}

/** Whether this turn's workspace is in the pilot, whoever started the turn. */
export function backgroundActionsOfCaller(context: ModeContext) {
  const workspaceId = callerWorkspace(context);
  return workspaceId !== undefined && backgroundActionsPilot(workspaceId);
}

/**
 * Whether this turn is a scheduled task's worker in the pilot: the one kind
 * of background turn that may do what its schedule holds. Proactive checks,
 * the agentic worker, schedule reports and browser reports never are.
 */
export function delegatingRun(context: ModeContext) {
  return (
    resolveModeValue(context, { "scheduled-worker": true }) === true &&
    backgroundActionsOfCaller(context)
  );
}

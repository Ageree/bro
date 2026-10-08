import { defineState } from "eve/context";
import type { SessionContext } from "eve/context";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { renewPhoneReportLease } from "@db/services/phone";
import { phoneReportCaller } from "./report-caller";

/**
 * The report a turn was opened for, kept in eve's durable session state. A
 * person's message that steers into a running report turn replaces
 * `auth.current` with their own (eve's `turn-step` sets `AuthKey` from the
 * latest delivery), and the caller then no longer names the report: without
 * this the turn could neither renew the lease nor settle the report, and the
 * report went out again. eve numbers turns per session loop and starts again
 * from `turn_0` in a successor run, so the entry is closed with its turn and
 * counts only under the turn id it was opened for.
 */
const reportTurn = defineState<{
  readonly callId: string;
  readonly token: string;
  readonly turnId: string;
  readonly userId: string;
  readonly workspaceId: string;
} | null>("bro.phone-report-turn", () => null);

type TurnSession = Pick<SessionContext["session"], "auth" | "parent" | "turn">;

/**
 * The phone report this turn is for: by its caller, or, once someone steered
 * into the turn, by what the turn recorded when it began.
 */
export function phoneReportOfTurn(session: TurnSession) {
  if (session.parent) return undefined;
  const caller = phoneReportCaller(session.auth.current);
  if (caller)
    return {
      callId: caller.attributes.phoneCallId,
      scope: scopeFromPrincipal(caller),
      token: caller.attributes.phoneReportToken,
    };
  try {
    const held = reportTurn.get();
    if (held?.turnId !== session.turn.id) return undefined;
    return {
      callId: held.callId,
      scope: { userId: held.userId, workspaceId: held.workspaceId },
      token: held.token,
    };
  } catch {
    // Outside eve's context nothing is recorded.
    return undefined;
  }
}

/**
 * A turn begins: remember its report if it is one, and drop what an earlier
 * turn that never ended left behind.
 */
export function openPhoneReportTurn(session: TurnSession) {
  const caller = session.parent
    ? undefined
    : phoneReportCaller(session.auth.current);
  try {
    reportTurn.update(() =>
      caller
        ? {
            callId: caller.attributes.phoneCallId,
            token: caller.attributes.phoneReportToken,
            turnId: session.turn.id,
            userId: scopeFromPrincipal(caller).userId,
            workspaceId: caller.attributes.workspaceId,
          }
        : null
    );
  } catch {
    // Outside eve's context nothing is recorded; the caller still names the
    // report until someone steers into its turn.
  }
}

/** The turn ended, however it ended. */
export function closePhoneReportTurn() {
  try {
    reportTurn.update(() => null);
  } catch {
    // Outside eve's context there is nothing to close.
  }
}

export async function renewPhoneReportTurn(
  context: Pick<SessionContext, "session">
) {
  const report = phoneReportOfTurn(context.session);
  if (!report) return false;
  return renewPhoneReportLease(report.scope, report.callId, report.token);
}

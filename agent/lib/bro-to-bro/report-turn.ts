import { defineState, type SessionContext } from "eve/context";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { renewBroReportLease } from "@db/services/bro-to-bro/reports";
import { broReportCaller } from "./report-caller";

/**
 * The report a turn was opened for, kept in eve's durable session state, as
 * a phone report's is (`agent/lib/phone/report-lease.ts`): a person's
 * message that steers into the report's turn replaces `auth.current`, and
 * the caller then no longer names the report. The entry counts only under
 * the turn id it was opened for.
 */
const reportTurn = defineState<{
  readonly reportId: string;
  readonly token: string;
  readonly turnId: string;
  readonly userId: string;
  readonly workspaceId: string;
} | null>("bro.bro-report-turn", () => null);

type TurnSession = Pick<SessionContext["session"], "auth" | "parent" | "turn">;

/**
 * The Bro ↔ Bro report this turn is for: by its caller, or, once someone
 * steered into the turn, by what the turn recorded when it began.
 */
export function broReportOfTurn(session: TurnSession) {
  if (session.parent) return undefined;
  const caller = broReportCaller(session.auth.current);
  if (caller)
    return {
      reportId: caller.attributes.broReportId,
      scope: scopeFromPrincipal(caller),
      token: caller.attributes.broReportToken,
    };
  try {
    const held = reportTurn.get();
    if (held?.turnId !== session.turn.id) return undefined;
    return {
      reportId: held.reportId,
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
export function openBroReportTurn(session: TurnSession) {
  const caller = session.parent
    ? undefined
    : broReportCaller(session.auth.current);
  try {
    reportTurn.update(() =>
      caller
        ? {
            reportId: caller.attributes.broReportId,
            token: caller.attributes.broReportToken,
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
export function closeBroReportTurn() {
  try {
    reportTurn.update(() => null);
  } catch {
    // Outside eve's context there is nothing to close.
  }
}

/** Whether this turn's report still waits for it; its lease runs on. */
export async function renewBroReportTurn(
  context: Pick<SessionContext, "session">
) {
  const report = broReportOfTurn(context.session);
  if (!report) return false;
  return renewBroReportLease(report.scope, report.reportId, report.token);
}

import type { SessionContext } from "eve/context";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { stepContextPilotOfTool } from "@agent/lib/step-context/pilot";
import { reportDeliveredInTurn } from "./holds";

/**
 * What a card tool answers in a browser report's turn before the report's
 * message. Said as not done, so the model neither claims it nor takes the
 * refusal for a missing calendar.
 */
export const reportCardHoldRefusal =
  "Not done: in a browser report's turn a card cannot come before your message with the outcome. Send that message first, then call this again. Do not say it is added or done.";

/**
 * Why a card tool (`calendar-create-event`, `schedules-create`,
 * `connect_google`) may not run yet, or nothing. In a browser report's turn
 * a card that came before the outcome would ask about a booking the person
 * has not heard of and park the turn with the report undelivered
 * (`cardToolsBeforeOutcome`). Outside the pilot of the cache-friendly step
 * those tools are not offered there until the message is out, and nothing
 * is checked here; in the pilot the turn keeps one tool set
 * (`reportTurnTools`), so the tools refuse instead, in their approval and
 * again in their execute. The message is out once `send_message` recorded it
 * for this turn and report, or when the report had reached the person before
 * the turn began (`openReportTurn`). A state that cannot be read refuses. A
 * card asked for in the very step of the message is refused and comes in the
 * next one.
 */
export async function reportCardHold(
  session: Pick<SessionContext["session"], "auth" | "id" | "turn">
) {
  const runId = reportedBrowserRunId(session.auth.current);
  if (runId === undefined) return undefined;
  if (!(await stepContextPilotOfTool(session))) return undefined;
  if (reportDeliveredInTurn(session, runId) === true) return undefined;
  return reportCardHoldRefusal;
}

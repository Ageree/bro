import { defineState } from "eve/context";
import type { SessionAuth } from "eve/context";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";

/**
 * Whether the browser report of the current turn reached the person, kept
 * in eve's durable session state: a tool's approval and its execute see the
 * session but not the history, and the card tools of the pilot's fixed set
 * (`reportTurnTools`) have to tell for themselves whether the outcome went
 * out. The report's hook opens it at `turn.started` with what the database
 * said then (`openReportTurn`), and `send_message` marks it
 * (`markTurnDelivered`). eve numbers turns per session loop and starts again
 * from `turn_0` in a successor run, so the value names the run as well: one
 * left by another turn or another report counts for nothing.
 */
const turnHolds = defineState<{
  readonly delivered: boolean;
  readonly runId: string | null;
  readonly turnId: string | null;
}>("bro.turn-holds", () => ({ delivered: false, runId: null, turnId: null }));

/** The turn a tool or hook runs in, as eve hands it over. */
interface TurnSession {
  readonly auth: Pick<SessionAuth, "current">;
  readonly turn?: { readonly id: string };
}

function writeHold(
  session: TurnSession,
  value: { readonly delivered: boolean; readonly runId: string | null }
) {
  const turnId = session.turn?.id;
  if (turnId === undefined) return;
  try {
    turnHolds.update(() => ({ ...value, turnId }));
  } catch (error) {
    // Outside eve's context nothing is recorded, and the report's card
    // tools refuse (`reportCardHold`): fail closed.
    console.warn("[delivery] turn state not written", { cause: error });
  }
}

/**
 * Opens a browser report's turn: whether its report reached the person
 * before the turn began — a report sent again after its lease, or the turn
 * that resumes after the person answered its card. A delivery recorded later
 * in the database does not count: a `browser_task` `status` or `start` marks
 * the report delivered too (`agent/hooks/browser-run-report.ts`).
 */
export function openReportTurn(
  session: TurnSession,
  runId: string,
  deliveredBefore: boolean
) {
  writeHold(session, { delivered: deliveredBefore, runId });
}

/** Records that a message of this turn went to the person. */
export function markTurnDelivered(session: TurnSession) {
  writeHold(session, {
    delivered: true,
    runId: reportedBrowserRunId(session.auth.current) ?? null,
  });
}

/**
 * Whether the report of `runId` reached the person by this turn: true,
 * false, or undefined when the state cannot be read here.
 */
export function reportDeliveredInTurn(session: TurnSession, runId: string) {
  const turnId = session.turn?.id;
  if (turnId === undefined) return undefined;
  try {
    const holds = turnHolds.get();
    return holds.turnId === turnId && holds.runId === runId && holds.delivered;
  } catch {
    return undefined;
  }
}

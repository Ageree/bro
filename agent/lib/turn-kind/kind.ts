import type { DynamicResolveContext } from "eve";
import type { ModelMessage } from "ai";
import { turnCompaction } from "@agent/lib/compaction/mid-turn";
import {
  browserNoticeAuthenticator,
  reportedBrowserRunId,
} from "@agent/lib/browser-use/report-caller";
import { phoneReportCaller } from "@agent/lib/phone/report-caller";
import {
  turnOpenedByBackgroundTask,
  turnOpeningTexts,
} from "@agent/lib/delivery/turn-sends";
import { resolveModeValue } from "@agent/lib/mode";
import { backgroundNoticeText } from "@shared/chat/background-turn";
import type { StepIdentity } from "./step";

/**
 * Who a turn is for, which decides the one set of tools it is offered in
 * the pilot of the cache-friendly step (`turnTools`, docs/agent-costs.md,
 * 3.2): a person's message (web, Telegram, iMessage), a browser run's
 * report, the task agent's report, a schedule's worker, Bro's own mail and
 * calendar check, or a schedule's report. It is read from the caller and the
 * message that opened the turn, so it holds for every step of the turn. It
 * is not an agent mode: the mode tables of `resolveModeValue` stay as they
 * are.
 */
export type TurnKind =
  | "agentic-worker"
  | "background-task"
  | "browser-report"
  | "person"
  | "phone-report"
  | "proactive-worker"
  | "scheduled-report"
  | "scheduled-worker";

/**
 * The kind of the turn `context` is a step of. A turn eve compacted inside
 * (`turnCompaction`, by the `step`) may show a copy of an older message of
 * the person's as its opener, and the task agent's report would pass for
 * the person's turn with every tool: its kind comes from the turn's record
 * instead; a record that cannot tell whether it is that report, or no
 * record, takes the fewest tools.
 */
export function turnKind(
  context: {
    readonly messages: readonly ModelMessage[];
    readonly session: {
      readonly auth: DynamicResolveContext["session"]["auth"];
    };
  },
  step: StepIdentity
): TurnKind {
  const { backgroundTask, compaction } = turnCompaction(context.messages, step);
  if (compaction !== "inside") {
    // eve delivers the task agent's report in a turn that keeps the
    // previous turn's caller, a browser report's too.
    if (turnOpenedByBackgroundTask(context.messages)) return "background-task";
    return callerTurnKind(context);
  }
  return backgroundTask === false ? callerTurnKind(context) : "background-task";
}

/**
 * Whether the turn is a web chat's notice and nothing else
 * (`browserNoticeAuthenticator`). The caller alone does not tell: eve keeps
 * the last caller for a delivery that brings none (the task agent's report,
 * `turn-step.js`), and coalesces queued deliveries into one turn. Every
 * message that opened the turn must be the notice, or the turn goes to the
 * model as any other.
 */
export function browserNoticeTurn(context: Parameters<typeof turnKind>[0]) {
  if (
    context.session.auth.current?.authenticator !== browserNoticeAuthenticator
  ) {
    return false;
  }
  const openings = turnOpeningTexts(context.messages);
  return (
    openings.length > 0 &&
    openings.every((text) => backgroundNoticeText(text) !== undefined)
  );
}

function callerTurnKind(context: Parameters<typeof turnKind>[0]): TurnKind {
  if (phoneReportCaller(context.session.auth.current)) return "phone-report";
  if (reportedBrowserRunId(context.session.auth.current) !== undefined) {
    return "browser-report";
  }
  return (
    resolveModeValue<TurnKind>(context, {
      interactive: "person",
      "agentic-worker": "agentic-worker",
      "proactive-worker": "proactive-worker",
      "scheduled-report": "scheduled-report",
      "scheduled-worker": "scheduled-worker",
    }) ?? "person"
  );
}

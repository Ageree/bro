import type { DynamicResolveContext } from "eve";
import type { ModelMessage } from "ai";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { turnOpenedByBackgroundTask } from "@agent/lib/delivery/turn-sends";
import { resolveModeValue } from "@agent/lib/mode";

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
  | "background-task"
  | "browser-report"
  | "person"
  | "proactive-worker"
  | "scheduled-report"
  | "scheduled-worker";

export function turnKind(context: {
  readonly messages: readonly ModelMessage[];
  readonly session: {
    readonly auth: DynamicResolveContext["session"]["auth"];
  };
}): TurnKind {
  // eve delivers the task agent's report in a turn that keeps the previous
  // turn's caller, a browser report's too.
  if (turnOpenedByBackgroundTask(context.messages)) return "background-task";
  if (reportedBrowserRunId(context.session.auth.current) !== undefined) {
    return "browser-report";
  }
  return (
    resolveModeValue<TurnKind>(context, {
      interactive: "person",
      "proactive-worker": "proactive-worker",
      "scheduled-report": "scheduled-report",
      "scheduled-worker": "scheduled-worker",
    }) ?? "person"
  );
}

import type { ToolResultPart } from "ai";
import { z } from "zod";
import { isBackgroundTurnText } from "@shared/chat/background-turn";

/**
 * The line of a finished run's report that names the run
 * (`agent/lib/browser-use/completion.ts`). The report opens with the
 * background-turn marker, and this line follows it.
 */
const reportedRunLine = /^Browser run \S+ finished\.$/mu;

/**
 * Whether a turn's opening message is a finished browser run's report, not a
 * scheduled result or a person's message.
 */
export function isBrowserReportText(text: string) {
  return isBackgroundTurnText(text) && reportedRunLine.test(text);
}

const browserAnswerSchema = z.object({
  note: z.string().optional(),
  outcome: z.string().optional(),
  runId: z.string().optional(),
  status: z.string().optional(),
});

/** What a `browser_task` call answered, whether kept as JSON or as text. */
export function browserAnswer(output: ToolResultPart["output"]) {
  if (output.type === "json") {
    return browserAnswerSchema.safeParse(output.value).data;
  }
  if (output.type !== "text") return undefined;
  try {
    return browserAnswerSchema.safeParse(JSON.parse(output.value)).data;
  } catch {
    return undefined;
  }
}

/** Statuses of a run that has ended and has an outcome to tell. */
const settledRunStatuses = new Set(["done", "failed", "stopped"]);

/**
 * The run whose settled outcome a `browser_task` answer hands over — what
 * `status` returns once a run has ended — or nothing for a run still at
 * work, a cancel, or a start.
 */
export function settledOutcomeRun(output: ToolResultPart["output"]) {
  const answer = browserAnswer(output);
  if (!answer?.runId || !answer.status || !answer.outcome?.trim()) {
    return undefined;
  }
  return settledRunStatuses.has(answer.status) ? answer.runId : undefined;
}

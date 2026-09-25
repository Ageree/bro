import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { isBackgroundTurnText } from "@shared/chat/background-turn";

/**
 * The line of a finished run's report that names the run
 * (`agent/lib/browser-use/completion.ts`). The report opens with the
 * background-turn marker, and this line follows it.
 */
const reportedRunLine = /^Browser run (\S+) finished\.$/mu;

/**
 * The run whose report a turn's opening message is, or nothing for any other
 * message: a scheduled result, a person's message.
 */
export function reportedRunOf(text: string) {
  if (!isBackgroundTurnText(text)) return undefined;
  return reportedRunLine.exec(text)?.[1];
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

/** Statuses of a run still at work, whose report will follow by itself. */
const reportingStatuses = new Set(["created", "queued", "running", "waiting"]);

/**
 * Whether a `browser_task` answer left a run at work — a start or `continue`
 * that went through — whose own report will reach the person later. A
 * refusal, a failure, a cancel or a run out of credits leaves none.
 */
export function leavesRunAtWork(output: ToolResultPart["output"]) {
  if (output.type.startsWith("error") || output.type === "execution-denied") {
    return false;
  }
  const status = browserAnswer(output)?.status;
  return status !== undefined && reportingStatuses.has(status);
}

function openingText(message: ModelMessage) {
  if (!Array.isArray(message.content)) return message.content;
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * Whether `messages` left a browser errand at work whose report has not come
 * in yet: a run a start or `continue` handed work to, with neither its report
 * turn nor its outcome from `status` since.
 */
export function errandAtWork(messages: readonly ModelMessage[]) {
  const atWork = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      const reported = reportedRunOf(openingText(message));
      if (reported) atWork.delete(reported);
      continue;
    }
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "browser_task") {
        continue;
      }
      const started = browserAnswer(part.output)?.runId;
      if (started && leavesRunAtWork(part.output)) atWork.add(started);
      const settled = settledOutcomeRun(part.output);
      if (settled) atWork.delete(settled);
    }
  }
  return atWork.size > 0;
}

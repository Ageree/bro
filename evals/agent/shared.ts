import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { z } from "zod";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";

export const agentEvalTags = ["agent", "behavior"] as const;

export async function skipWithoutBrowser(t: EveEvalContext) {
  const { browserUseConfigured } =
    await import("@agent/lib/browser-use/client");
  if (!browserUseConfigured()) t.skip("browser_task needs BROWSER_USE_API_KEY");
}

// Only these actions start work; `status` and `cancel` name a run another
// call already started.
const runStartingCallSchema = z.object({
  action: z.enum(["start", "continue"]),
});
const startedRunSchema = z.object({ runId: z.string().min(1) });

/**
 * Stop every real run the session started, so a failed gate or judge never
 * leaves a browser working and billing. Runs in `finally`: it must not depend
 * on the model agreeing to cancel.
 */
export async function cancelStartedRuns(turn: EveEvalTurn | undefined) {
  if (!turn) return;
  const runIds = new Set(
    turn.toolCalls
      .filter(
        (call) =>
          call.name === "browser_task" &&
          runStartingCallSchema.safeParse(call.input).success
      )
      .map((call) => startedRunSchema.safeParse(call.output).data?.runId)
      .filter((runId) => runId !== undefined)
  );
  await Promise.all([...runIds].map(stopStartedRun));
}

/**
 * A cloud run is cancelled straight through Browser Use. An errand that went
 * to the queue has only a `queued:` row here — `eve dev` runs no poller to
 * start it — and is closed the way `browser_task cancel` closes it: left
 * queued, it would send every later eval's start to the back of the line.
 */
async function stopStartedRun(runId: string) {
  try {
    const cloudRunId = runId.startsWith("queued:")
      ? await closeQueuedRun(runId)
      : runId;
    if (cloudRunId === undefined) return;
    const { cancelBrowserUseRun } =
      await import("@agent/lib/browser-use/client");
    await cancelBrowserUseRun(cloudRunId);
  } catch {
    // Already finished or already cancelled: nothing left to stop.
  }
}

/** The cloud run the errand was handed to, if it started before the close. */
async function closeQueuedRun(runId: string) {
  const { closeQueuedBrowserRun, readBrowserRun } =
    await import("@db/services/browser-runs");
  const closed = await closeQueuedBrowserRun(runId, {
    outcome: "The eval stopped this errand before it started.",
    status: "stopped",
  });
  if (closed) {
    const { releaseBrowserRunSpend } =
      await import("@agent/lib/browser-use/spend");
    await releaseBrowserRunSpend(runId);
    return undefined;
  }
  return (await readBrowserRun(runId))?.retriedAsRunId ?? undefined;
}

/**
 * The one message the turn got through to the person. A send the runtime
 * dropped as a repeat or returned for a rewrite completes too, but reached
 * nobody (`agent/lib/delivery/turn-sends.ts`), so it is not counted.
 */
export async function requireDeliveredText(
  t: EveEvalContext,
  turn: EveEvalTurn
) {
  const delivery = turn.requireToolCall("send_message", {
    output: (output) => sendMessageOutputSchema.safeParse(output).success,
    status: "completed",
  });
  const parsed = sendMessageOutputSchema.safeParse(delivery.input);
  const text =
    parsed.success && parsed.data.kind === "message"
      ? parsed.data.text
      : undefined;
  const parsedText = z.string().trim().min(1).safeParse(text);

  await t.require(parsedText.success, equals(true));
  if (!parsedText.success) {
    throw new Error("send_message did not deliver non-empty text.");
  }
  return parsedText.data;
}

export function assertPlainTextDelivery(t: EveEvalContext, text: string) {
  t.check(
    text,
    satisfies<string>(
      (value) =>
        !/(?:^|\n)#{1,6}\s/u.test(value) &&
        !/(?:^|\n)\s*(?:[-*+] |\d+\. )/u.test(value) &&
        !/\*\*|```|\[[^\]]+\]\([^)]+\)/u.test(value),
      "delivery uses plain iMessage text instead of Markdown"
    )
  );
}

/**
 * Joins every text bubble the turns delivered. Bro splits longer replies
 * into several `send_message` calls, so a single-delivery lookup misses them.
 */
export async function requireDeliveredTexts(
  t: EveEvalContext,
  ...turns: EveEvalTurn[]
) {
  const text = [...new Set(turns)]
    .flatMap((turn) => turn.toolCalls)
    .filter(
      (call) =>
        call.name === "send_message" &&
        call.status === "completed" &&
        // A send the runtime dropped or returned reached nobody.
        sendMessageOutputSchema.safeParse(call.output).success
    )
    .map((call) => sendMessageOutputSchema.safeParse(call.input))
    .flatMap((parsed) =>
      parsed.success && parsed.data.kind === "message" ? [parsed.data.text] : []
    )
    .join("\n")
    .trim();

  await t.require(text.length > 0, equals(true));
  return text;
}

/**
 * A text that asks the person something. A question needs no question mark
 * — «Уточните время», «Напиши адрес» — so a request for an answer counts as
 * one too.
 */
const askingPattern =
  /\?|(?<!\p{L})(?:уточни|подскажи|скажи|напиши|пришли|выбери|ответь|дай(?:те)? знать|нужно ли|хочешь ли|хотите ли|удобно ли|подойд[её]т ли)/iu;

/** What the turn asked the person in text rather than on a card. */
function questionTexts(turn: EveEvalTurn) {
  return turn.toolCalls
    .filter(
      (call) => call.name === "send_message" && call.status === "completed"
    )
    .map((call) => sendMessageOutputSchema.safeParse(call.input))
    .flatMap((parsed) =>
      parsed.success && parsed.data.kind === "message"
        ? [parsed.data.text ?? ""]
        : []
    )
    .filter((text) => askingPattern.test(text));
}

/** The one-card contract: no question before the card, in any tool. */
export function checkNoQuestionBeforeCard(
  t: EveEvalContext,
  turn: EveEvalTurn
) {
  turn.notCalledTool("ask_question");
  t.check(
    questionTexts(turn),
    satisfies<string[]>(
      (texts) => texts.length === 0,
      "no question in text before the card"
    )
  );
}

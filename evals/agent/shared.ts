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

const startedRunSchema = z.object({ runId: z.string().min(1) });

/**
 * Stop every real run the session started, straight through Browser Use, so
 * a failed gate or judge never leaves a browser working and billing. Runs in
 * `finally`: it must not depend on the model agreeing to cancel.
 */
export async function cancelStartedRuns(turn: EveEvalTurn | undefined) {
  if (!turn) return;
  const { cancelBrowserUseRun } = await import("@agent/lib/browser-use/client");
  const runIds = turn.toolCalls
    .filter((call) => call.name === "browser_task")
    .map((call) => startedRunSchema.safeParse(call.output).data?.runId)
    .filter((runId) => runId !== undefined);
  await Promise.all(
    runIds.map(async (runId) => {
      try {
        await cancelBrowserUseRun(runId);
      } catch {
        // Already finished or already cancelled: nothing left to stop.
      }
    })
  );
}

export async function requireDeliveredText(
  t: EveEvalContext,
  turn: EveEvalTurn
) {
  const delivery = turn.requireToolCall("send_message", {
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
      (call) => call.name === "send_message" && call.status === "completed"
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

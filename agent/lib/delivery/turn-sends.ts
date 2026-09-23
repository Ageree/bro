import type { ModelMessage } from "ai";
import { z } from "zod";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";

/**
 * User-visible messages one turn may deliver. Nothing Bro does in a single
 * turn needs more, and a model stuck in a loop would otherwise post dozens of
 * copies to a chat the person cannot stop.
 */
export const turnMessageLimit = 6;

/**
 * Two texts at least this similar are the same message said twice. A loop
 * rarely repeats itself byte for byte: it trims a word or swaps punctuation.
 */
const nearDuplicateSimilarity = 0.9;

/** What a delivered send is compared by: its words and exact attachments. */
const sentMessageSchema = z.object({
  attachments: z.array(z.string()),
  text: z.string(),
});

export type SentMessage = z.infer<typeof sentMessageSchema>;

/** A `send_message` call after its input passed the tool's schema. */
type OutgoingMessage = z.infer<typeof sendMessageOutputSchema>;

type SkipReason = "duplicate" | "limit";

const skippedPrefix = "Not delivered:";

const skipNotices = {
  duplicate: `${skippedPrefix} the person already received this message in this turn. Do not send it again. End the turn now without calling send_message.`,
  limit: `${skippedPrefix} this turn already delivered ${String(turnMessageLimit)} messages, the most one reply may take. End the turn now without calling any tool.`,
} as const satisfies Record<SkipReason, string>;

/** The tool result the model reads for a send that was dropped. */
export function skippedSendNotice(reason: SkipReason) {
  return skipNotices[reason];
}

function normalizedText(text: string) {
  const lower = text.normalize("NFKC").toLocaleLowerCase();
  const words = lower.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // A message of only emoji or punctuation is compared as written.
  return words || lower.replace(/\s+/gu, " ").trim();
}

/** The comparable form of a message `send_message` was asked to send. */
export function sentMessageOf(message: OutgoingMessage): SentMessage {
  if (message.kind === "link") return { attachments: [message.url], text: "" };
  return {
    attachments: (message.attachments ?? []).map(({ url }) => url).toSorted(),
    text: normalizedText(message.text ?? ""),
  };
}

function bigrams(text: string) {
  const counts = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** Sørensen–Dice similarity of two texts over character bigrams, 0 to 1. */
function similarity(left: string, right: string) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  let shared = 0;
  for (const [pair, count] of leftPairs) {
    shared += Math.min(count, rightPairs.get(pair) ?? 0);
  }
  return (2 * shared) / (left.length - 1 + (right.length - 1));
}

function isRepeat(message: SentMessage, earlier: SentMessage) {
  return (
    message.attachments.join("\n") === earlier.attachments.join("\n") &&
    similarity(message.text, earlier.text) >= nearDuplicateSimilarity
  );
}

/**
 * Why a send must not reach the person, given what this turn already
 * delivered, or nothing when it may go out.
 */
export function sendSkipReason(
  outgoing: OutgoingMessage,
  delivered: readonly SentMessage[]
): SkipReason | undefined {
  if (delivered.length >= turnMessageLimit) return "limit";
  const message = sentMessageOf(outgoing);
  if (delivered.some((earlier) => isRepeat(message, earlier))) {
    return "duplicate";
  }
  return undefined;
}

const taggedMessageSchema = z.object({ kind: z.string() });

/**
 * eve tags user-role messages with a kind. Context, memory, retry, and
 * compaction messages are injected inside a running turn; anything else, a
 * person's message or a background wakeup, starts a new one.
 */
function startsTurn(message: ModelMessage) {
  if (message.role !== "user") return false;
  const kind = taggedMessageSchema.safeParse(message).data?.kind ?? "user";
  return !(
    kind.startsWith("context.") ||
    kind.startsWith("memory.") ||
    kind === "execution.retry" ||
    kind === "execution.continuation"
  );
}

function currentTurnMessages(messages: readonly ModelMessage[]) {
  const start = messages.findLastIndex(startsTurn);
  return start === -1 ? messages : messages.slice(start + 1);
}

/**
 * What `send_message` did so far in the current turn: the messages that
 * reached the person, and how many sends were dropped as repeats or over the
 * limit.
 */
export function turnSends(messages: readonly ModelMessage[]) {
  const inputs = new Map<string, OutgoingMessage>();
  const delivered: SentMessage[] = [];
  let skipped = 0;
  for (const message of currentTurnMessages(messages)) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part.type === "tool-call" && part.toolName === "send_message") {
        const input = sendMessageOutputSchema.safeParse(part.input).data;
        if (input) inputs.set(part.toolCallId, input);
      }
      if (part.type !== "tool-result" || part.toolName !== "send_message") {
        continue;
      }
      const { output } = part;
      if (output.type === "text" && output.value.startsWith(skippedPrefix)) {
        skipped += 1;
        continue;
      }
      if (output.type.startsWith("error") || output.type === "execution-denied")
        continue;
      const input = inputs.get(part.toolCallId);
      if (input) delivered.push(sentMessageOf(input));
    }
  }
  return { delivered, skipped };
}

/**
 * Whether the turn has to end now: the model already repeated a delivered
 * message or used up the limit, so another step may only write the closing
 * text.
 */
export function turnMustEnd(messages: readonly ModelMessage[]) {
  const { delivered, skipped } = turnSends(messages);
  return skipped > 0 || delivered.length >= turnMessageLimit;
}

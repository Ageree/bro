import type { ModelMessage } from "ai";
import { z } from "zod";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { type ReplyLanguage, wrongReplyLanguage } from "./language";

/**
 * User-visible messages one turn may deliver. Nothing Bro does in a single
 * turn needs more, and a model stuck in a loop would otherwise post dozens of
 * copies to a chat the person cannot stop.
 */
export const turnMessageLimit = 6;

/**
 * Two texts at least this similar are the same message said twice, provided
 * they carry the same specifics. A loop rarely repeats itself byte for byte:
 * it trims a word or swaps punctuation.
 */
const nearDuplicateSimilarity = 0.9;

/**
 * Skips a turn may take before it is ended. One dropped repeat can precede a
 * real answer the model still has to send; a second means it is looping.
 */
const skipsBeforeEnd = 2;

/**
 * What a delivered send is compared by: its words, exact attachments, and the
 * specifics that make two messages from one template different.
 */
const sentMessageSchema = z.object({
  attachments: z.array(z.string()),
  specifics: z.array(z.string()),
  text: z.string(),
});

export type SentMessage = z.infer<typeof sentMessageSchema>;

/** A `send_message` call after its input passed the tool's schema. */
type OutgoingMessage = z.infer<typeof sendMessageOutputSchema>;

type SkipReason = "duplicate" | "limit";

const skippedPrefix = "Not delivered:";

const skipNotices = {
  duplicate: `${skippedPrefix} the person already received this message in this turn. Do not send it again. Send only something new that is still missing; if nothing is, end the turn now without calling send_message.`,
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

/**
 * Numbers, dates, times, codes, names, and links as written: two messages
 * from one template, such as the outbound and the return flight or option 1
 * and option 2, differ only in these, so they are never repeats of each other.
 */
function specificsOf(text: string) {
  const tokens = text
    .normalize("NFKC")
    .split(/\s+/u)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(
      (token) =>
        /\p{N}/u.test(token) ||
        /^\p{Lu}/u.test(token) ||
        // Identifier-shaped codes such as `order_ab` or `abc-def`.
        /[\p{L}\p{N}][-_][\p{L}\p{N}]/u.test(token) ||
        token.includes("://")
    );
  // A capital that only opens a sentence is not a specific.
  const sentenceStarts = new Set(
    [...text.matchAll(/(?:^|[.!?…]\s+)([\p{L}]+)/gu)].flatMap(([, word]) =>
      word && !/^\p{Lu}{2,}$/u.test(word) ? [word] : []
    )
  );
  return [...new Set(tokens)]
    .filter((token) => !sentenceStarts.has(token))
    .toSorted();
}

/** The comparable form of a message `send_message` was asked to send. */
export function sentMessageOf(message: OutgoingMessage): SentMessage {
  if (message.kind === "link") {
    return { attachments: [message.url], specifics: [], text: "" };
  }
  const text = message.text ?? "";
  return {
    attachments: (message.attachments ?? []).map(({ url }) => url).toSorted(),
    specifics: specificsOf(text),
    text: normalizedText(text),
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
  if (message.attachments.join("\n") !== earlier.attachments.join("\n")) {
    return false;
  }
  if (message.text === earlier.text) return true;
  return (
    message.specifics.join("\n") === earlier.specifics.join("\n") &&
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

/**
 * Sends a turn may have bounced for the wrong language. A model that cannot
 * switch keeps writing the same way; after this many retries its message goes
 * out rather than the person getting nothing.
 */
const languageRetries = 2;

const wrongLanguagePrefix = "Not delivered, wrong language:";

const wrongLanguageNotices = {
  en: `${wrongLanguagePrefix} the person wrote in English, but this message is in Russian. Rewrite the same message in English and call send_message again.`,
  ru: `${wrongLanguagePrefix} человек пишет по-русски, а это сообщение на английском. Перепиши его по-русски и снова вызови send_message.`,
} as const satisfies Record<ReplyLanguage, string>;

/** The tool result the model reads for a send bounced for its language. */
export function wrongLanguageNotice(language: ReplyLanguage) {
  return wrongLanguageNotices[language];
}

/**
 * Whether a send must be bounced because it is plainly not in the language
 * the person wrote in, while the turn still has retries for that.
 */
export function bouncesForLanguage(
  outgoing: OutgoingMessage,
  expected: ReplyLanguage | null,
  languageSkips: number
) {
  return (
    expected !== null &&
    languageSkips < languageRetries &&
    outgoing.kind === "message" &&
    outgoing.text !== undefined &&
    wrongReplyLanguage(outgoing.text, expected)
  );
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

export function currentTurnMessages(messages: readonly ModelMessage[]) {
  const start = messages.findLastIndex(startsTurn);
  return start === -1 ? messages : messages.slice(start + 1);
}

/**
 * What `send_message` did so far in the current turn: the messages that
 * reached the person, how many sends were dropped as repeats or over the
 * limit, and how many bounced for their language.
 */
export function turnSends(messages: readonly ModelMessage[]) {
  const inputs = new Map<string, OutgoingMessage>();
  const delivered: SentMessage[] = [];
  let skipped = 0;
  let languageSkips = 0;
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
      if (
        output.type === "text" &&
        output.value.startsWith(wrongLanguagePrefix)
      ) {
        languageSkips += 1;
        continue;
      }
      if (output.type.startsWith("error") || output.type === "execution-denied")
        continue;
      const input = inputs.get(part.toolCallId);
      if (input) delivered.push(sentMessageOf(input));
    }
  }
  return { delivered, languageSkips, skipped };
}

/**
 * Whether the turn has to end now: the model kept repeating delivered
 * messages or used up the limit, so another step may only write the closing
 * text.
 */
export function turnMustEnd(messages: readonly ModelMessage[]) {
  const { delivered, skipped } = turnSends(messages);
  return skipped >= skipsBeforeEnd || delivered.length >= turnMessageLimit;
}

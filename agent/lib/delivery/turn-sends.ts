import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { isBackgroundTurnText } from "@shared/chat/background-turn";
import {
  type UnperformedClaim,
  turnActions,
  unperformedClaim,
  unperformedClaims,
} from "./claims";
import {
  addsNothingNew,
  codesOf,
  namesOf,
  namesShared,
  nearDuplicateSimilarity,
  normalizedText,
  properNamesOf,
  questionsOf,
  type SentMessage,
  similarity,
} from "./novelty";

/**
 * User-visible messages one turn may deliver. A reply is one message; a
 * second one is for news — a question, another option — and a third is
 * already a lot to read. A model stuck in a loop would otherwise post copy
 * after copy to a chat the person cannot stop.
 */
export const turnMessageLimit = 3;

/**
 * Sends a turn may have dropped before it is ended. A dropped send means the
 * model is past its answer and only rephrasing it, so the next step may only
 * write the closing text.
 */
const skipsBeforeEnd = 1;

/**
 * Sends returned for a rewrite before one goes through as written. A model
 * that keeps the same claim twice is left to it, rather than leaving the
 * person without a reply.
 */
const rewritesBeforeYield = 2;

/** A `send_message` call after its input passed the tool's schema. */
type OutgoingMessage = z.infer<typeof sendMessageOutputSchema>;

const skipReasonSchema = z.enum(["duplicate", "limit", "stale"]);

type SkipReason = z.infer<typeof skipReasonSchema>;

/**
 * What `send_message` returns instead of the message when it drops a send or
 * sends it back for a rewrite. Channels deliver only results that parse as a
 * message, so neither reaches the person.
 */
export const sendRefusalSchema = z.union([
  z.object({ skipped: skipReasonSchema }),
  z.object({ rewrite: z.enum(unperformedClaims) }),
]);

const skippedPrefix = "Not delivered:";
const rewritePrefix = "Not delivered, rewrite it:";

const skipNotices = {
  duplicate: `${skippedPrefix} the person already received this message in this turn. Do not send it again: the reply is complete, so end the turn now without calling any tool.`,
  limit: `${skippedPrefix} this turn already delivered ${String(turnMessageLimit)} messages, the most one reply may take. End the turn now without calling any tool.`,
  stale: `${skippedPrefix} it adds nothing to what this turn already sent — no new result, number, link, name, option or question, only the same status in other words. The person already has your answer and knows the outcome will follow. End the turn now without calling any tool.`,
} as const satisfies Record<SkipReason, string>;

const rewriteNotices = {
  browser: `${rewritePrefix} it says something already happened on the site — a code entered, a page opened, a new code requested, a slot confirmed, a booking or an order made — but the browser run in this turn was only handed the errand and has done nothing yet (status running). Say that you started it or passed the message on and that you will send what it finds; claim only what a tool result in this turn shows.`,
  calendar: `${rewritePrefix} it says the calendar is being or has been changed, but no calendar event was created, changed or deleted in this turn. Make the change with the calendar tool first and report its result, or say you will add it once the person confirms the details; never present a slot you picked yourself as booked.`,
} as const satisfies Record<UnperformedClaim, string>;

/** The tool result the model reads for a send that was dropped. */
export function skippedSendNotice(reason: SkipReason) {
  return skipNotices[reason];
}

/** The tool result the model reads for a send it has to rewrite. */
export function rewriteSendNotice(claim: UnperformedClaim) {
  return rewriteNotices[claim];
}

/** The comparable form of a message `send_message` was asked to send. */
export function sentMessageOf(message: OutgoingMessage): SentMessage {
  if (message.kind === "link") {
    return {
      attachments: [message.url],
      codes: [],
      names: [],
      properNames: [],
      questions: [],
      text: "",
    };
  }
  const text = message.text ?? "";
  return {
    attachments: (message.attachments ?? []).map(({ url }) => url).toSorted(),
    codes: codesOf(text),
    names: namesOf(text),
    properNames: properNamesOf(text),
    questions: questionsOf(text),
    text: normalizedText(text),
  };
}

function isRepeat(message: SentMessage, earlier: SentMessage) {
  return (
    message.attachments.join("\n") === earlier.attachments.join("\n") &&
    message.codes.join("\n") === earlier.codes.join("\n") &&
    namesShared(message, earlier) &&
    namesShared(earlier, message) &&
    similarity(message.text, earlier.text) >= nearDuplicateSimilarity
  );
}

/** Whether a message says again what one of the delivered ones said. */
export function repeatsDelivered(
  outgoing: OutgoingMessage,
  delivered: readonly SentMessage[]
) {
  const message = sentMessageOf(outgoing);
  return delivered.some((earlier) => isRepeat(message, earlier));
}

/**
 * Why a send must not reach the person as written, given what this turn
 * already did, or nothing when it may go out. A skip drops it for good; a
 * claim sends it back to be rewritten.
 */
export function sendRefusal(
  outgoing: OutgoingMessage,
  turn: ReturnType<typeof turnSends>
): z.infer<typeof sendRefusalSchema> | undefined {
  const { delivered } = turn;
  if (delivered.length >= turnMessageLimit) return { skipped: "limit" };
  if (repeatsDelivered(outgoing, delivered)) return { skipped: "duplicate" };
  if (
    addsNothingNew(sentMessageOf(outgoing), delivered, {
      afterWork: turn.workSinceDelivery,
    })
  ) {
    return { skipped: "stale" };
  }
  if (turn.rewrites >= rewritesBeforeYield || outgoing.kind !== "message") {
    return undefined;
  }
  const claim = unperformedClaim(outgoing.text ?? "", turn.actions);
  return claim ? { rewrite: claim } : undefined;
}

function refusalOf(output: ToolResultPart["output"]) {
  if (output.type !== "text") return undefined;
  if (output.value.startsWith(skippedPrefix)) return "skipped" as const;
  if (output.value.startsWith(rewritePrefix)) return "rewrite" as const;
  return undefined;
}

/**
 * Whether a `send_message` result is a message the person received: not a
 * failure, a refusal, or a send this guard dropped or returned.
 */
export function sendReachedPerson(output: ToolResultPart["output"]) {
  if (output.type.startsWith("error") || output.type === "execution-denied") {
    return false;
  }
  return refusalOf(output) === undefined;
}

const taggedMessageSchema = z.object({ kind: z.string() });

/**
 * eve tags user-role messages with a kind. Context, memory, retry, and
 * compaction messages are injected inside a running turn; anything else, a
 * person's message or a background wakeup, starts a new one.
 */
export function startsTurn(message: ModelMessage) {
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

function openingText(message: ModelMessage | undefined) {
  if (!message) return "";
  if (!Array.isArray(message.content)) return message.content;
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/** Tools whose result is the reply itself rather than work towards it. */
const deliveryTools = new Set(["react_to_message", "send_message"]);

/**
 * What `send_message` did so far in the current turn: the messages that
 * reached the person, how many sends were dropped or sent back for a
 * rewrite, whether other tools ran since the last delivery, and what the
 * turn did that a message could claim. It rides in the durable closure of
 * `send_message`, so it stays plain JSON.
 */
export function turnSends(messages: readonly ModelMessage[]) {
  const start = messages.findLastIndex(startsTurn);
  const turn = start === -1 ? messages : messages.slice(start + 1);
  const inputs = new Map<string, OutgoingMessage>();
  const delivered: SentMessage[] = [];
  let skipped = 0;
  let rewrites = 0;
  let workSinceDelivery = false;
  for (const message of turn) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part.type === "tool-call" && part.toolName === "send_message") {
        const input = sendMessageOutputSchema.safeParse(part.input).data;
        if (input) inputs.set(part.toolCallId, input);
      }
      if (part.type !== "tool-result") continue;
      if (!deliveryTools.has(part.toolName)) {
        workSinceDelivery = true;
        continue;
      }
      if (part.toolName !== "send_message") continue;
      const refusal = refusalOf(part.output);
      if (refusal === "skipped") skipped += 1;
      if (refusal === "rewrite") rewrites += 1;
      if (!sendReachedPerson(part.output)) continue;
      const input = inputs.get(part.toolCallId);
      if (!input) continue;
      delivered.push(sentMessageOf(input));
      workSinceDelivery = false;
    }
  }
  return {
    actions: turnActions(turn, start === -1 ? [] : messages.slice(0, start), {
      background: isBackgroundTurnText(openingText(messages[start])),
    }),
    delivered,
    rewrites,
    skipped,
    workSinceDelivery,
  };
}

/**
 * Whether the turn has to end now: the model sent something that added
 * nothing, or used up the limit, so another step may only write the closing
 * text.
 */
export function turnMustEnd(messages: readonly ModelMessage[]) {
  const { delivered, skipped } = turnSends(messages);
  return skipped >= skipsBeforeEnd || delivered.length >= turnMessageLimit;
}

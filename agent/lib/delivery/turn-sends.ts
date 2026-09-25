import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { isBackgroundTurnText } from "@shared/chat/background-turn";
import { turnActions, unperformedClaim, unperformedClaims } from "./claims";
import {
  errandAtWork,
  reportedRunOf,
  leavesRunAtWork,
  settledOutcomeRun,
} from "./browser-report";
import {
  addsNothingNew,
  announcesWork,
  asksOrShowsNew,
  carriesFacts,
  codesOf,
  namesOf,
  namesShared,
  nearDuplicateSimilarity,
  normalizedText,
  properNamesOf,
  questionsOf,
  requestsOf,
  type SentMessage,
  similarity,
  tellsFacts,
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

const skipReasonSchema = z.enum(["duplicate", "limit", "reported", "stale"]);

type SkipReason = z.infer<typeof skipReasonSchema>;

/**
 * Why a send goes back to be rewritten: it claims what no tool did, it only
 * announces work that has not started, so the answer would follow as a
 * second message, or it only announces a browser report's result. A calendar
 * claim in a browser report's turn before its message has its own notice:
 * the calendar tool is held back there until that message goes out
 * (`cardToolsBeforeOutcome`), so the only way on is the future tense.
 */
const rewriteReasons = [
  ...unperformedClaims,
  "calendar-later",
  "report",
  "status",
] as const;

type RewriteReason = (typeof rewriteReasons)[number];

/**
 * What `send_message` returns instead of the message when it drops a send or
 * sends it back for a rewrite. Channels deliver only results that parse as a
 * message, so neither reaches the person.
 */
export const sendRefusalSchema = z.union([
  z.object({ skipped: skipReasonSchema }),
  z.object({ rewrite: z.enum(rewriteReasons) }),
]);

const skippedPrefix = "Not delivered:";
const rewritePrefix = "Not delivered, rewrite it:";

const skipNotices = {
  duplicate: `${skippedPrefix} the person already received this message in this turn. Do not send it again: the reply is complete, so end the turn now without calling any tool.`,
  limit: `${skippedPrefix} this turn already delivered ${String(turnMessageLimit)} messages, the most one reply may take. End the turn now without calling any tool.`,
  reported: `${skippedPrefix} this browser result already reached the person in this turn, as one message, and this one tells the same result again — restated, with a detail added, or corrected. The person gets a browser result once. Another message goes out only when it asks them for something new — a code, a confirmation, a choice — or brings a picture or a link they need. If the report still asks you to act — browser_task continue on the errand, the calendar entry for a booking, a schedule for a later step — do that without writing again; otherwise end the turn now without calling any tool.`,
  stale: `${skippedPrefix} it adds nothing to what this turn already sent — no new result, number, link, name, option or question, only the same status in other words. The person already has your answer and knows the outcome will follow. End the turn now without calling any tool.`,
} as const satisfies Record<SkipReason, string>;

const rewriteNotices = {
  browser: `${rewritePrefix} it says something already happened on the site — a code entered, a page opened, a new code requested, a slot confirmed, a booking or an order made — but the browser run in this turn was only handed the errand and has done nothing yet (status running). Say that you started it or passed the message on and that you will send what it finds; claim only what a tool result in this turn shows.`,
  calendar: `${rewritePrefix} it says the calendar is being or has been changed, but no calendar event was created, changed or deleted in this turn. Make the change with the calendar tool first and report its result, or say you will add it once the person confirms the details; never present a slot you picked yourself as booked.`,
  "calendar-later": `${rewritePrefix} it says the calendar is being or has been changed, but no calendar event was created, changed or deleted in this turn, and in a browser report's turn the calendar tool comes back only once this message has reached the person. Keep the outcome and say the calendar step in the future tense — «добавлю в календарь», once they confirm the card — never «добавляю» or «добавил»; then call the calendar tool right after this message.`,
  report: `${rewritePrefix} it only announces what you are about to tell, and the browser report is already in front of you. Tell the person now, in this one message, what the run found or where the errand stands, with the facts the report names.`,
  status: `${rewritePrefix} it only says you are on it or will write later, and no tool result of this turn backs it yet, so the answer would follow as a second message. If a tool you called in this same step is doing that work (a browser errand you started, a search), its result is in now: send again and say what it shows. Never start the same errand twice. Otherwise do the work with the tools it needs first, then send what you found in one message.`,
} as const satisfies Record<RewriteReason, string>;

/** The tool result the model reads for a send that was dropped. */
export function skippedSendNotice(reason: SkipReason) {
  return skipNotices[reason];
}

/** The tool result the model reads for a send it has to rewrite. */
export function rewriteSendNotice(reason: RewriteReason) {
  return rewriteNotices[reason];
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
      requests: [],
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
    requests: requestsOf(text),
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
 * Whether the first message of a person's turn only announces work that has
 * not begun — «смотрю почту», «поищу и пришлю» — so the answer would follow
 * as a second message. It is judged before any tool of the turn answered: a
 * browser errand that runs on after the turn has started by then, and so has
 * any work whose result the message may be reporting. A message that asks
 * the person something, shows them something, or names a fact their own
 * message did not is no mere announcement.
 */
function announcesUnstartedWork(
  message: SentMessage,
  turn: ReturnType<typeof turnSends>
) {
  return (
    turn.request !== undefined &&
    // «ок, жду» → «пришлю, как найду» about an errand already at work is
    // true, and «start it» would only start it twice.
    !turn.errandAtWork &&
    turn.delivered.length === 0 &&
    !turn.worked &&
    message.attachments.length === 0 &&
    message.questions.length === 0 &&
    message.requests.length === 0 &&
    announcesWork(message) &&
    addsNothingNew(message, [turn.request], { afterWork: false })
  );
}

/**
 * Whether the first message of a browser report's turn only announces the
 * result — «Секунду, смотрю, что нашёл браузер» — while the report in front
 * of the model already holds it.
 */
function announcesReport(
  message: SentMessage,
  turn: ReturnType<typeof turnSends>
) {
  return (
    turn.report &&
    turn.delivered.length === 0 &&
    !turn.worked &&
    message.attachments.length === 0 &&
    message.questions.length === 0 &&
    message.requests.length === 0 &&
    announcesWork(message) &&
    !carriesFacts(message)
  );
}

/**
 * Why a send must not reach the person as written, given what this turn
 * already did, or nothing when it may go out. A skip drops it for good; a
 * claim or an announcement sends it back to be rewritten.
 *
 * A browser report's turn tells its result in one message. Once a message of
 * the turn told it, only a new question, request, picture or link goes out —
 * unless the turn did other work since (a calendar entry, a reminder, an
 * errand that failed to go on), whose result is news of its own. A heading or
 * a question sent before the result does not count as telling it.
 */
export function sendRefusal(
  outgoing: OutgoingMessage,
  turn: ReturnType<typeof turnSends>
): z.infer<typeof sendRefusalSchema> | undefined {
  const { delivered } = turn;
  if (delivered.length >= turnMessageLimit) return { skipped: "limit" };
  if (repeatsDelivered(outgoing, delivered)) return { skipped: "duplicate" };
  const message = sentMessageOf(outgoing);
  if (
    turn.report &&
    delivered.some((sent) => tellsFacts(sent)) &&
    !turn.otherWorkSinceDelivery &&
    !asksOrShowsNew(message, delivered)
  ) {
    return { skipped: "reported" };
  }
  if (
    addsNothingNew(message, delivered, { afterWork: turn.workSinceDelivery })
  ) {
    return { skipped: "stale" };
  }
  if (turn.rewrites >= rewritesBeforeYield || outgoing.kind !== "message") {
    return undefined;
  }
  if (announcesReport(message, turn)) return { rewrite: "report" };
  if (announcesUnstartedWork(message, turn)) return { rewrite: "status" };
  const claim = unperformedClaim(outgoing.text ?? "", turn.actions);
  if (claim === "calendar" && turn.report && delivered.length === 0) {
    return { rewrite: "calendar-later" };
  }
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
 * The person's own message that opened the turn, as a message a send is
 * compared with, or nothing when Bro opened it: a browser report, a
 * scheduled result, a background wakeup.
 */
function personRequest(opening: ModelMessage | undefined) {
  if (opening?.role !== "user") return undefined;
  const kind = taggedMessageSchema.safeParse(opening).data?.kind ?? "user";
  const text = openingText(opening);
  if (kind !== "user" || isBackgroundTurnText(text)) return undefined;
  return sentMessageOf({ kind: "message", text });
}

/**
 * Whether a tool result is news the person has yet to hear in a browser
 * report's turn. A `continue` or a start that left a run at work is not: that
 * run reports by itself. Nor is `status` handing over this report's own
 * outcome. Everything else is: other tools' work, and a `browser_task` that
 * failed, was refused, ran out of credits, was cancelled, or handed over
 * another errand's outcome.
 */
function newsForReport(part: ToolResultPart, reportedRun: string | undefined) {
  if (part.toolName !== "browser_task") return true;
  if (leavesRunAtWork(part.output)) return false;
  const handedOver = settledOutcomeRun(part.output);
  return handedOver === undefined || handedOver !== reportedRun;
}

/**
 * What `send_message` did so far in the current turn: the messages that
 * reached the person, how many sends were dropped or sent back for a
 * rewrite, whether the turn did any work and whether it did more since the
 * last delivery or since a dropped send, what the turn did that a message
 * could claim, who opened it — the person's own message, or a browser run's
 * report — and whether an earlier turn left an errand at work. It rides in
 * the durable closure of `send_message`, so it stays plain JSON.
 */
export function turnSends(messages: readonly ModelMessage[]) {
  const start = messages.findLastIndex(startsTurn);
  const turn = start === -1 ? messages : messages.slice(start + 1);
  const earlier = start === -1 ? [] : messages.slice(0, start);
  const opening = openingText(messages[start]);
  const reportedRun = reportedRunOf(opening);
  const inputs = new Map<string, OutgoingMessage>();
  const delivered: SentMessage[] = [];
  let skipped = 0;
  let rewrites = 0;
  let worked = false;
  let workSinceDelivery = false;
  let otherWorkSinceDelivery = false;
  let workAfterSkip = false;
  for (const message of turn) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part.type === "tool-call" && part.toolName === "send_message") {
        const input = sendMessageOutputSchema.safeParse(part.input).data;
        if (input) inputs.set(part.toolCallId, input);
      }
      if (part.type !== "tool-result") continue;
      if (!deliveryTools.has(part.toolName)) {
        worked = true;
        workSinceDelivery = true;
        if (skipped > 0) workAfterSkip = true;
        if (newsForReport(part, reportedRun)) otherWorkSinceDelivery = true;
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
      otherWorkSinceDelivery = false;
    }
  }
  return {
    actions: turnActions(turn, earlier, {
      background: isBackgroundTurnText(opening),
    }),
    delivered,
    errandAtWork: errandAtWork(earlier),
    otherWorkSinceDelivery,
    /** Whether a finished browser run's report opened the turn. */
    report: reportedRun !== undefined,
    request: personRequest(messages[start]),
    rewrites,
    skipped,
    workAfterSkip,
    workSinceDelivery,
    worked,
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

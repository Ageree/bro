import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { isBackgroundTurnText } from "@shared/chat/background-turn";
import {
  claimsResultsInHand,
  promisesUntakenStep,
  turnActions,
  unperformedClaim,
  unperformedClaims,
} from "./claims";
import {
  browserAnswer,
  errandAtWork,
  reportedRunOf,
  leavesRunAtWork,
  settledOutcomeRun,
} from "./browser-report";
import {
  addsNothingNew,
  announcesErrand,
  announcesWork,
  asksOrShowsNew,
  carriesFacts,
  codesOf,
  distinctStems,
  mentionsErrand,
  namesOf,
  namesShared,
  nearDuplicateSimilarity,
  normalizedText,
  properNamesOf,
  questionsOf,
  requestsOf,
  retellsAroundQuestion,
  type SentMessage,
  similarity,
  statedIn,
  tellsBeyond,
  tellsFacts,
  withoutFound,
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
 * Messages about an errand the turn may have dropped before it is ended. The
 * first leaves the turn open: the person may have asked for more than the
 * errand, and a model that announced that step («сейчас поставлю в
 * календарь») instead of taking it would otherwise never take it.
 */
const errandSkipsBeforeEnd = 2;

/**
 * Sends returned for a rewrite before one goes through as written. A model
 * that keeps the same claim twice is left to it, rather than leaving the
 * person without a reply.
 */
const rewritesBeforeYield = 2;

/** A `send_message` call after its input passed the tool's schema. */
type OutgoingMessage = z.infer<typeof sendMessageOutputSchema>;

const skipReasonSchema = z.enum([
  "duplicate",
  "limit",
  "reported",
  "stale",
  "started",
]);

type SkipReason = z.infer<typeof skipReasonSchema>;

/**
 * Why a send goes back to be rewritten: it claims what no tool did, it only
 * announces work that has not started, so the answer would follow as a
 * second message, it only announces a browser report's result, or it wraps
 * a question in the answer told again, or it only announces a step no tool
 * has taken, or it says options were found that nothing has found yet. A
 * calendar claim in a browser report's turn before its message has its own
 * notice: the calendar tool is held back there until that message goes out
 * (`cardToolsBeforeOutcome`), so the only way on is the future tense.
 */
const rewriteReasons = [
  ...unperformedClaims,
  "announced",
  "calendar-later",
  "found",
  "report",
  "restated",
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

/**
 * How every rewrite notice ends. The draft never reached the person, so its
 * rewrite corrects nothing they read: a notice that only called the draft
 * untrue stayed in the history, and a later turn opened with «Прошу
 * прощения, ошибся в прошлом сообщении» about a message that was right (RU
 * d15, 25.09).
 */
const unseenDraft =
  "The person never saw this draft, so the rewrite corrects nothing they read: no apology and no «ошибся» about it, now or later.";

const skipNotices = {
  duplicate: `${skippedPrefix} the person already received this message in this turn. Do not send it again: the reply is complete, so end the turn now without calling any tool.`,
  limit: `${skippedPrefix} this turn already delivered ${String(turnMessageLimit)} messages, the most one reply may take. End the turn now without calling any tool.`,
  reported: `${skippedPrefix} this browser result already reached the person in this turn, as one message, and this one tells the same result again — restated, with a detail added, or corrected. The person gets a browser result once. Another message goes out only when it asks them for something new — a code, a confirmation, a choice — or brings a picture or a link they need. If the report still asks you to act — browser_task continue on the errand, the calendar entry for a booking, a schedule for a later step — do that without writing again; otherwise end the turn now without calling any tool.`,
  stale: `${skippedPrefix} it adds nothing to what this turn already sent — no new result, number, link, name, option or question, only the same status in other words. The person already has your answer and knows the outcome will follow. End the turn now without calling any tool.`,
  started: `${skippedPrefix} the person already has this turn's message about the errand you handed the browser, and an errand gets one such message: what the run finds reaches them in its own report, as a new turn. Where it runs, what it was asked to do and that nothing is done yet are no news to them. If the person asked in this turn for something else you have not done yet — a calendar entry, a reminder — do it now with its tool, without announcing it first; otherwise end the turn now without calling any tool.`,
} as const satisfies Record<SkipReason, string>;

const rewriteNotices = {
  announced: `${rewritePrefix} it adds nothing to what this turn already sent except the announcement of a step you have not taken — a calendar entry, a reminder. Take the step now with its tool instead of writing about it; its result is what you tell the person. If the step waits for the person's answer or a card, do not write again: end the turn now without calling any tool.`,
  browser: `${rewritePrefix} it says something already happened on the site — a code entered, a page opened, a new code requested, a slot confirmed, a booking or an order made — but the browser run in this turn was only handed the errand and has done nothing yet (status running). Say that you started it or passed the message on and that you will send what it finds; claim only what a tool result in this turn shows.`,
  declined: `${rewritePrefix} it says something was done — a reminder, task or schedule set or changed, an event added, a letter or a Slack message sent, something remembered or forgotten, an order placed — but its tool call was declined on its card, refused or failed, so it was not done. Say plainly that it was not done and why — the person declined the card, or the call was refused or failed — and keep the rest of the message. Do not present it as done, and do not try it again unless the person asks.`,
  undone: `${rewritePrefix} it says something was done — a reminder or schedule set or changed, a letter or a Slack message sent, something remembered or forgotten — but no tool result of this turn shows it. If you called its tool in this same step, its result is in now: send again and say what it shows, without calling that tool again. If an earlier conversation or turn did it, say so plainly («уже стоит с прошлого раза»). Otherwise do it with its tool first and tell what the result shows, or say it is not done yet.`,
  calendar: `${rewritePrefix} it says the calendar is being or has been changed, but no calendar event was created, changed or deleted in this turn. Make the change with the calendar tool first and report its result, or say you will add it once the person confirms the details; never present a slot you picked yourself as booked.`,
  "calendar-later": `${rewritePrefix} it says the calendar is being or has been changed, but no calendar event was created, changed or deleted in this turn, and in a browser report's turn the calendar tool comes back only once this message has reached the person. Keep the outcome and say the calendar step in the future tense — «добавлю в календарь», once they confirm the card — never «добавляю» or «добавил»; then call the calendar tool right after this message.`,
  found: `${rewritePrefix} it says you picked or found options — «подобрал три места», «вот варианты» — but names none of them, and no search, read or report of this turn has returned any yet, so the list would follow as a second message. If a search you called in this same step has returned, send what it found now: each option with the facts that matter and its link, in this one message. Otherwise search first, then send the options in one message; until then say only what you started, never that options are picked. Keep the rest of the message.`,
  report: `${rewritePrefix} it only announces what you are about to tell, and the browser report is already in front of you. Tell the person now, in this one message, what the run found or where the errand stands, with the facts the report names.`,
  restated: `${rewritePrefix} around its question it tells again the answer the person already got in this turn — the same places, numbers and links — and a second telling in other words reads as a different answer. Send the question alone, in one short sentence, without restating or changing the answer; if nothing needs asking, end the turn now without calling any tool.`,
  status: `${rewritePrefix} it only says you are on it or will write later, and no tool result of this turn backs it yet, so the answer would follow as a second message. If a tool you called in this same step is doing that work (a browser errand you started, a search), its result is in now: send again and say what it shows. Never start the same errand twice. Otherwise do the work with the tools it needs first, then send what you found in one message.`,
} as const satisfies Record<RewriteReason, string>;

/** The tool result the model reads for a send that was dropped. */
export function skippedSendNotice(reason: SkipReason) {
  return skipNotices[reason];
}

/** The tool result the model reads for a send it has to rewrite. */
export function rewriteSendNotice(reason: RewriteReason) {
  return `${rewriteNotices[reason]} ${unseenDraft}`;
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

type NameMatching = NonNullable<Parameters<typeof namesShared>[2]>;

function isRepeat(
  message: SentMessage,
  earlier: SentMessage,
  names: NameMatching
) {
  return (
    message.attachments.join("\n") === earlier.attachments.join("\n") &&
    message.codes.join("\n") === earlier.codes.join("\n") &&
    namesShared(message, earlier, names) &&
    namesShared(earlier, message, names) &&
    similarity(message.text, earlier.text) >= nearDuplicateSimilarity
  );
}

/**
 * Whether a message says again what one of the delivered ones said. `names`
 * says which names may match in another case (`namesShared`).
 */
export function repeatsDelivered(
  outgoing: OutgoingMessage,
  delivered: readonly SentMessage[],
  names: NameMatching = {}
) {
  const message = sentMessageOf(outgoing);
  return delivered.some((earlier) => isRepeat(message, earlier, names));
}

/**
 * Why a send that adds nothing is dropped, or nothing when it may go out:
 * `stale` for the same answer or status again, `started` for another
 * message about the errand the turn handed a browser run. That one message
 * is the one the run's report follows; a later one passes only with news —
 * a question, a picture or a link, other work's result, or a number or name
 * that neither the person, the errand nor the turn's messages named.
 */
function heldBack(message: SentMessage, turn: ReturnType<typeof turnSends>) {
  const { delivered } = turn;
  if (
    addsNothingNew(message, delivered, {
      afterWork: turn.workSinceDelivery,
      distinct: turn.distinct,
      foldable: turn.foldable,
      request: turn.request,
    })
  ) {
    return "stale";
  }
  if (
    turn.request &&
    turn.errandTold &&
    mentionsErrand(message) &&
    !turn.otherWorkSinceDelivery &&
    !asksOrShowsNew(message, delivered) &&
    !tellsBeyond(message, [
      turn.request,
      ...(turn.errandInput ? [turn.errandInput] : []),
      ...delivered,
    ])
  ) {
    return "started";
  }
  return undefined;
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
 *
 * So does a browser errand the person's turn started or continued: the
 * message after it says it is under way, and the run's own report tells what
 * it found. In RU d05 (25.09) three messages in a row said the order had
 * been handed to Лавка, each with a detail of the errand the one before left
 * out.
 */
export function sendRefusal(
  outgoing: OutgoingMessage,
  turn: ReturnType<typeof turnSends>
): z.infer<typeof sendRefusalSchema> | undefined {
  const { delivered } = turn;
  if (delivered.length >= turnMessageLimit) return { skipped: "limit" };
  if (repeatsDelivered(outgoing, delivered, turn)) {
    return { skipped: "duplicate" };
  }
  const message = sentMessageOf(outgoing);
  if (
    turn.report &&
    delivered.some((sent) => tellsFacts(sent)) &&
    !turn.otherWorkSinceDelivery &&
    !asksOrShowsNew(message, delivered)
  ) {
    return { skipped: "reported" };
  }
  const yields =
    turn.rewrites >= rewritesBeforeYield || outgoing.kind !== "message";
  const held = heldBack(message, turn);
  if (held) {
    // Dropped, it would end the turn before the step it announces is taken.
    return !yields &&
      !turn.errandRunning &&
      promisesUntakenStep(
        outgoing.text ?? "",
        turn.actions,
        turn.request?.text ?? ""
      )
      ? { rewrite: "announced" }
      : { skipped: held };
  }
  if (yields) return undefined;
  if (announcesReport(message, turn)) return { rewrite: "report" };
  if (announcesUnstartedWork(message, turn)) return { rewrite: "status" };
  if (
    !turn.workSinceDelivery &&
    retellsAroundQuestion(outgoing.text ?? "", message, delivered, turn.stated)
  ) {
    return { rewrite: "restated" };
  }
  const claim = unperformedClaim(outgoing.text ?? "", turn.actions);
  if (claim === "calendar" && turn.report && delivered.length === 0) {
    return { rewrite: "calendar-later" };
  }
  if (claim) return { rewrite: claim };
  if (
    claimsResultsInHand(outgoing.text ?? "", turn.actions) &&
    !showsOptions(outgoing.text ?? "", message, turn)
  ) {
    return { rewrite: "found" };
  }
  return undefined;
}

/**
 * Whether a message shows the options it says it found: a picture, two lines
 * or more after the line that claims them — a list, bulleted or not — or a
 * number, a link or a name that neither the person's message nor the turn's
 * tool inputs — the errand handed to a browser, the queries — already carry.
 */
function showsOptions(
  text: string,
  message: SentMessage,
  turn: ReturnType<typeof turnSends>
) {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const claimed = lines.findIndex((line) =>
    claimsResultsInHand(line, turn.actions)
  );
  return (
    message.attachments.length > 0 ||
    lines.length - claimed - 1 >= 2 ||
    tellsBeyond(message, [turn.given])
  );
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
 * The text of the person's own message that opened the turn, or nothing
 * when Bro opened it: a browser report, a scheduled result, a background
 * wakeup.
 */
function personRequestText(opening: ModelMessage | undefined) {
  if (opening?.role !== "user") return undefined;
  const kind = taggedMessageSchema.safeParse(opening).data?.kind ?? "user";
  const text = openingText(opening);
  if (kind !== "user" || isBackgroundTurnText(text)) return undefined;
  return text;
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

const browserCallSchema = z.object({ action: z.string() });

const jsonSchema = z.json();

/** What the turn handed its browser runs, as a message is compared with it. */
function errandSent(texts: readonly string[]) {
  return sentMessageOf({ kind: "message", text: texts.join("\n") });
}

const jsonTextSchema = z.union([z.string(), z.number()]);
const jsonListSchema = z.array(jsonSchema);
const jsonRecordSchema = z.record(z.string(), jsonSchema);

/** Every string and number in a tool's input or output, wherever it sits. */
function stringsOf(value: z.infer<typeof jsonSchema>): string[] {
  const text = jsonTextSchema.safeParse(value);
  if (text.success) return [String(text.data)];
  const list = jsonListSchema.safeParse(value);
  if (list.success) return list.data.flatMap(stringsOf);
  const record = jsonRecordSchema.safeParse(value);
  if (record.success) return Object.values(record.data).flatMap(stringsOf);
  return [];
}

/** The text a tool's result carries, as JSON or as text. */
function resultTexts(output: ToolResultPart["output"]) {
  if (output.type === "text" || output.type === "error-text") {
    return [output.value];
  }
  if (output.type !== "json" && output.type !== "error-json") return [];
  const value = jsonSchema.safeParse(output.value);
  return value.success ? stringsOf(value.data) : [];
}

/** `browser_task` actions that hand a run the errand, anew or further. */
const errandHandovers = new Set(["continue", "start"]);

/**
 * What `send_message` did so far in the current turn: the messages that
 * reached the person, how many sends were dropped or sent back for a
 * rewrite, whether the turn did any work and whether it did more since the
 * last delivery or since a dropped send, whether a message went out since
 * the turn last handed a browser run its errand, what the turn did that a
 * message could claim, who opened it — the person's own message, or a
 * browser run's report — and whether an earlier turn left an errand at work.
 * It rides in the durable closure of `send_message`, so it stays plain JSON.
 */
export function turnSends(messages: readonly ModelMessage[]) {
  const start = messages.findLastIndex(startsTurn);
  const turn = start === -1 ? messages : messages.slice(start + 1);
  const earlier = start === -1 ? [] : messages.slice(0, start);
  const opening = openingText(messages[start]);
  const reportedRun = reportedRunOf(opening);
  const requestText = personRequestText(messages[start]);
  const request =
    requestText === undefined
      ? undefined
      : sentMessageOf({ kind: "message", text: requestText });
  const inputs = new Map<string, OutgoingMessage>();
  const browserActions = new Map<string, string>();
  const browserTexts = new Map<string, string[]>();
  const errandTexts: string[] = [];
  // What the turn's other tools found: a search, a route, the orders.
  const foundTexts: string[] = [];
  // What the person may be taken to know of the errand: what the turn
  // handed its browser runs, less what its other tools found and the model
  // only passed on.
  const errandKnown = () =>
    withoutFound(errandSent(errandTexts), errandSent(foundTexts));
  const delivered: SentMessage[] = [];
  let skipped = 0;
  let errandSkips = 0;
  let rewrites = 0;
  let worked = false;
  let workSinceDelivery = false;
  let otherWorkSinceDelivery = false;
  let workAfterSkip = false;
  // Errands handed over in this turn whose message has not gone out yet: a
  // step may start two, and each gets its own.
  let errandsUntold = 0;
  let errandHandedOver = false;
  // Runs this turn handed work to whose outcome has not come in yet.
  const runsAtWork = new Set<string>();
  // The words of the turn's tool inputs, which the model wrote with the
  // person's own words in mind.
  const inputTexts: string[] = [];
  for (const message of turn) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part.type === "tool-call" && part.toolName === "send_message") {
        const input = sendMessageOutputSchema.safeParse(part.input).data;
        if (input) inputs.set(part.toolCallId, input);
      }
      if (part.type === "tool-call" && !deliveryTools.has(part.toolName)) {
        const input = jsonSchema.safeParse(part.input);
        if (input.success) inputTexts.push(...stringsOf(input.data));
      }
      if (part.type === "tool-call" && part.toolName === "browser_task") {
        const action = browserCallSchema.safeParse(part.input).data?.action;
        if (action) browserActions.set(part.toolCallId, action);
        const input = jsonSchema.safeParse(part.input);
        if (input.success) {
          browserTexts.set(part.toolCallId, stringsOf(input.data));
        }
      }
      if (part.type !== "tool-result") continue;
      if (!deliveryTools.has(part.toolName)) {
        worked = true;
        workSinceDelivery = true;
        if (skipped > 0) workAfterSkip = true;
        if (newsForReport(part, reportedRun)) otherWorkSinceDelivery = true;
        if (part.toolName !== "browser_task") {
          foundTexts.push(...resultTexts(part.output));
        }
        const settled =
          part.toolName === "browser_task"
            ? settledOutcomeRun(part.output)
            : undefined;
        if (settled) runsAtWork.delete(settled);
        if (
          part.toolName === "browser_task" &&
          errandHandovers.has(browserActions.get(part.toolCallId) ?? "") &&
          leavesRunAtWork(part.output)
        ) {
          errandHandedOver = true;
          errandsUntold += 1;
          const run = browserAnswer(part.output)?.runId;
          if (run) runsAtWork.add(run);
          errandTexts.push(...(browserTexts.get(part.toolCallId) ?? []));
        }
        continue;
      }
      if (part.toolName !== "send_message") continue;
      const refusal = refusalOf(part.output);
      if (refusal === "skipped") skipped += 1;
      if (refusal === "rewrite") rewrites += 1;
      if (
        part.output.type === "text" &&
        part.output.value === skipNotices.started
      ) {
        errandSkips += 1;
      }
      if (!sendReachedPerson(part.output)) continue;
      const input = inputs.get(part.toolCallId);
      if (!input) continue;
      const sent = sentMessageOf(input);
      delivered.push(sent);
      // A message that follows other work — a search in the same step as the
      // errand, a calendar entry — may tell that work's result rather than
      // the errand; it uses up the errand's one message only when it talks
      // about the errand and names nothing beyond the request and the errand.
      if (
        errandsUntold > 0 &&
        (!otherWorkSinceDelivery ||
          (announcesErrand(sent) &&
            !tellsBeyond(sent, [...(request ? [request] : []), errandKnown()])))
      ) {
        errandsUntold -= 1;
      }
      workSinceDelivery = false;
      otherWorkSinceDelivery = false;
    }
  }
  const previousStart = earlier.findLastIndex(startsTurn);
  return {
    actions: turnActions(turn, earlier, {
      background: isBackgroundTurnText(opening),
      previousTurn:
        previousStart === -1 ? earlier : earlier.slice(previousStart),
      request: requestText,
    }),
    delivered,
    /** Stems on which the person named two people (`distinctStems`). */
    distinct: requestText === undefined ? [] : distinctStems(requestText),
    errandAtWork: errandAtWork(earlier),
    /** What the turn handed its browser runs: task, site, submission. */
    errandInput: errandTexts.length > 0 ? errandKnown() : undefined,
    /** How many messages about the errand were dropped as `started`. */
    errandSkips,
    /**
     * Whether every errand the turn handed a browser run — a `start` or
     * `continue` that left it at work — has had its message: one that
     * reached the person with no other work to tell, or that talked about
     * the errand and named nothing beyond it.
     */
    errandTold: errandHandedOver && errandsUntold === 0,
    /** Whether a run this turn handed work to has yet to report. */
    errandRunning: runsAtWork.size > 0,
    /**
     * What the person's message and the turn's tool inputs already named: a
     * message that names nothing beyond them shows no option it found.
     */
    given: sentMessageOf({
      kind: "message",
      text: [requestText ?? "", ...inputTexts].join("\n"),
    }),
    /**
     * The words of the person's message and of the turn's tool inputs: names
     * among them may match in another case (`namesShared`).
     */
    foldable: [
      ...new Set(
        normalizedText([requestText ?? "", ...inputTexts].join("\n")).split(" ")
      ),
    ],
    otherWorkSinceDelivery,
    /** Whether a finished browser run's report opened the turn. */
    report: reportedRun !== undefined,
    /** The person's own message that opened the turn, if they opened it. */
    request,
    rewrites,
    skipped,
    /** What that message states, without what it asks or asks for. */
    stated:
      requestText === undefined
        ? undefined
        : sentMessageOf({ kind: "message", text: statedIn(requestText) }),
    workAfterSkip,
    workSinceDelivery,
    worked,
  };
}

/**
 * Whether the turn has to end now: the model sent something that added
 * nothing, or used up the limit, so another step may only write the closing
 * text. A first message about the errand dropped as `started` leaves one
 * more step for what else the person asked for.
 */
export function turnMustEnd(messages: readonly ModelMessage[]) {
  const { delivered, errandSkips, skipped } = turnSends(messages);
  return (
    skipped - errandSkips >= skipsBeforeEnd ||
    errandSkips >= errandSkipsBeforeEnd ||
    delivered.length >= turnMessageLimit
  );
}

import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { browserAnswer } from "./browser-report";

/**
 * A message that reports as done what no tool did. In the benchmark Bro wrote
 * «код принял, ввёл — кабинет открылся» a second after `browser_task
 * continue` answered `running`, and «пока ставлю в календарь 11:00–12:00»
 * with no calendar call at all. The person acts on such a message, so it goes
 * back to the model to be rewritten rather than out to the chat.
 *
 * The check stays narrow on purpose: it reads only the first person's past
 * and present of a few verbs, and only when the turn itself shows the action
 * has not happened — a browser run it just handed work to, or no calendar
 * write where one is claimed. What Bro did in earlier turns is left alone.
 */
export const unperformedClaims = ["browser", "calendar"] as const;

export type UnperformedClaim = (typeof unperformedClaims)[number];

/** Statuses of a `browser_task` answer for a run that has done nothing yet. */
const pendingRunStatuses = new Set(["queued", "running"]);

const calendarWriteTools = new Set([
  "calendar-create-event",
  "calendar-delete-event",
  "calendar-update-event",
]);

function succeeded(output: ToolResultPart["output"]) {
  return !output.type.startsWith("error") && output.type !== "execution-denied";
}

function toolResults(messages: readonly ModelMessage[]) {
  return messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.filter((part) => part.type === "tool-result")
      : []
  );
}

const appsRunSchema = z.object({ action: z.literal("run"), tool: z.string() });

const appsDoneSchema = z.object({ status: z.literal("done") });

/** A Composio calendar tool: Outlook, Calendly, Google through `apps`. */
const appsCalendarTool = /CALENDAR|EVENT|MEETING/u;

/**
 * The calendar tools the `apps` tool ran in `messages`, by call id: the call
 * names the tool, its result only says whether it went through.
 */
function appsCalendarCalls(messages: readonly ModelMessage[]) {
  return new Set(
    messages.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.flatMap((part) =>
            part.type === "tool-call" &&
            part.toolName === "apps" &&
            appsCalendarTool.test(
              appsRunSchema.safeParse(part.input).data?.tool ?? ""
            )
              ? [part.toolCallId]
              : []
          )
        : []
    )
  );
}

/**
 * Whether a tool result is a calendar event created, changed or deleted: by
 * Bro's own calendar tools, or by a calendar tool of another app through
 * `apps` («поставь в мой Outlook»).
 */
function wroteCalendar(part: ToolResultPart, appsCalls: Set<string>) {
  if (!succeeded(part.output)) return false;
  if (calendarWriteTools.has(part.toolName)) return true;
  return (
    part.toolName === "apps" &&
    appsCalls.has(part.toolCallId) &&
    part.output.type === "json" &&
    appsDoneSchema.safeParse(part.output.value).success
  );
}

/**
 * What the current turn has done that a message could claim. `turn` is the
 * turn after its opening message, `earlier` everything before that message.
 * A turn a background prompt opened — a browser run's report, a scheduled
 * result — relays what happened elsewhere, so its browser claims are not
 * checked.
 */
export function turnActions(
  turn: readonly ModelMessage[],
  earlier: readonly ModelMessage[],
  options: { readonly background: boolean }
) {
  let browserPending = false;
  let codeTyped = false;
  let calendarWritten = false;
  const appsCalls = appsCalendarCalls([...earlier, ...turn]);
  for (const part of toolResults(turn)) {
    if (!succeeded(part.output)) continue;
    if (wroteCalendar(part, appsCalls)) calendarWritten = true;
    if (part.toolName !== "browser_task") continue;
    const answer = browserAnswer(part.output);
    if (answer?.status && pendingRunStatuses.has(answer.status)) {
      browserPending = true;
    }
    if (answer?.note?.includes("code went straight into the page")) {
      codeTyped = true;
    }
  }
  return {
    browserPending: browserPending && !options.background,
    calendarWritten,
    calendarWrittenEarlier: toolResults(earlier).some((part) =>
      wroteCalendar(part, appsCalls)
    ),
    codeTyped,
  };
}

/**
 * A sentence about another time («в прошлый раз ввёл», «вчера поставил») is
 * not about this turn.
 */
const otherTime =
  /(?:^|[^\p{L}])(?:в прошлый раз|раньше|вчера|тогда|до этого|прошл\p{L}*|earlier|yesterday|last time)(?=[^\p{L}]|$)/u;

/** What typing a code is called; a code the tool typed itself is true. */
const typingVerbs = ["ввел", "вбил", "вписал", "entered", "typed in"];

/**
 * What a run did on the site, said as done. «код принял» is Bro receiving
 * the code, which is true, so it is not here.
 */
const browserVerbs = [
  ...typingVerbs,
  "вошел",
  "залогинился",
  "залез",
  "зашел в кабинет",
  "зашел в личный",
  "зашел в аккаунт",
  "открылся",
  "открылась",
  "открылось",
  "открылись",
  "запросил",
  "подтвердил",
  "подтвержден",
  "подтверждена",
  "подтверждено",
  "нажал",
  "забронировал",
  "оформил",
  "заказал",
  "оплатил",
  "записал вас",
  "записал тебя",
  "записался",
  "записалась",
  "отправил заявку",
  "отправил заявление",
  "отправил форму",
  "отправил анкету",
  "logged in",
  "signed in",
  "booked",
  "ordered",
  "paid",
  "submitted",
  "requested a new code",
];

/** Putting something into the calendar, said as happening now. */
const calendarPresentVerbs = [
  "ставлю",
  "добавляю",
  "вношу",
  "заношу",
  "создаю",
  "занимаю",
  "записываю",
  "переношу",
  "удаляю",
  "убираю",
  "adding",
  "putting",
];

/** The same, said as done. */
const calendarPastVerbs = [
  "поставил",
  "добавил",
  "внес",
  "занес",
  "создал",
  "занял",
  "записал",
  "перенес",
  "удалил",
  "убрал",
  "added",
  "scheduled",
  "created",
];

const calendarNoun = /календар|событи|calendar/u;

/**
 * Where the person's events already are: «записал: по пятницам у тебя в
 * календаре зал» describes the calendar, it does not change it.
 */
const theirCalendar =
  /(?:у (?:тебя|вас|него|нее) в|в (?:твоем|вашем|своем)) календаре/gu;

function sentencesOf(text: string) {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll("ё", "е")
    .split(/[.!?…;\n]+/u)
    .filter((sentence) => !otherTime.test(sentence));
}

/** Words that negate a verb or make it the person's: «не ставлю», «ты добавил». */
const notMine = new Set(["не", "ты", "not", "you"]);

/**
 * Whether a sentence says one of the one-word phrases within `distance` words
 * of the calendar. A claim in the present puts them together («ставлю в
 * календарь слот 11:00»); a list of what Bro does only has them in one
 * sentence («разбираю почту, календарь и Диск, ставлю напоминания»).
 */
function saysNearCalendar(
  sentence: string,
  phrases: readonly string[],
  distance = 3
) {
  const words = sentence.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const nouns = words.flatMap((word, index) =>
    calendarNoun.test(word) ? [index] : []
  );
  return words.some(
    (word, index) =>
      phrases.includes(word) &&
      !words
        .slice(Math.max(0, index - 2), index)
        .some((before) => notMine.has(before)) &&
      nouns.some((noun) => Math.abs(noun - index) <= distance)
  );
}

function escaped(phrase: string) {
  return phrase.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Whether a sentence says one of the phrases, not negated («ещё не ввёл») and
 * not about the person («ты подтвердил»).
 */
function says(sentence: string, phrases: readonly string[]) {
  return phrases.some((phrase) =>
    new RegExp(
      `(?<!(?:^|[^\\p{L}])(?:не|ты|not|you)\\s+(?:\\p{L}+\\s+)?)(?<![\\p{L}])${escaped(phrase)}(?![\\p{L}])`,
      "u"
    ).test(sentence)
  );
}

/**
 * What a message claims as done that this turn has not done, or nothing.
 * `actions` is what `turnActions` found.
 */
export function unperformedClaim(
  text: string,
  actions: ReturnType<typeof turnActions>
): UnperformedClaim | undefined {
  const sentences = sentencesOf(text);
  if (actions.browserPending) {
    const verbs = actions.codeTyped
      ? browserVerbs.filter((verb) => !typingVerbs.includes(verb))
      : browserVerbs;
    if (sentences.some((sentence) => says(sentence, verbs))) return "browser";
  }
  if (!actions.calendarWritten) {
    // A past tense after an earlier turn wrote to the calendar may well be
    // about that write. A past tense anywhere in the sentence claims a write
    // («Записал: встреча в пятницу в календаре»); a present one only next to
    // the calendar.
    const claimed = sentences.some((sentence) => {
      const own = sentence.replaceAll(theirCalendar, "");
      if (!calendarNoun.test(own)) return false;
      return (
        saysNearCalendar(own, calendarPresentVerbs) ||
        (!actions.calendarWrittenEarlier && says(sentence, calendarPastVerbs))
      );
    });
    if (claimed) return "calendar";
  }
  return undefined;
}

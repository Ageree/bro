import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";

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

const browserAnswerSchema = z.object({
  note: z.string().optional(),
  status: z.string().optional(),
});

function succeeded(output: ToolResultPart["output"]) {
  return !output.type.startsWith("error") && output.type !== "execution-denied";
}

function browserAnswer(output: ToolResultPart["output"]) {
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

function toolResults(messages: readonly ModelMessage[]) {
  return messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.filter((part) => part.type === "tool-result")
      : []
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
  for (const part of toolResults(turn)) {
    if (!succeeded(part.output)) continue;
    if (calendarWriteTools.has(part.toolName)) calendarWritten = true;
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
    calendarWrittenEarlier: toolResults(earlier).some(
      (part) => calendarWriteTools.has(part.toolName) && succeeded(part.output)
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
    // about that write.
    const verbs = actions.calendarWrittenEarlier
      ? calendarPresentVerbs
      : [...calendarPresentVerbs, ...calendarPastVerbs];
    const claimed = sentences.some(
      (sentence) =>
        calendarNoun.test(sentence.replaceAll(theirCalendar, "")) &&
        says(sentence, verbs)
    );
    if (claimed) return "calendar";
  }
  return undefined;
}

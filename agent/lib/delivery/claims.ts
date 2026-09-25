import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { browserAnswer } from "./browser-report";
import { requestsOf } from "./novelty";

/**
 * A message that reports as done what no tool did. In the benchmark Bro wrote
 * «код принял, ввёл — кабинет открылся» a second after `browser_task
 * continue` answered `running`, and «пока ставлю в календарь 11:00–12:00»
 * with no calendar call at all. The person acts on such a message, so it goes
 * back to the model to be rewritten rather than out to the chat.
 *
 * The check stays narrow on purpose: it reads only the first person's past
 * and present of a few verbs, and only when the turn itself shows the action
 * has not happened — a browser run it just handed work to, no calendar write
 * where one is claimed, a call the person declined on its card, a policy
 * refused or that failed, or, in the person's own turn, no call at all of the
 * reminder, letter, Slack message or memory claimed. What Bro did in earlier
 * turns is left alone.
 */
export const unperformedClaims = [
  "browser",
  "calendar",
  "declined",
  "undone",
] as const;

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
 * Actions a message may claim as done, by the tools that do them. In RU d02
 * (25.09) the person declined the `schedules-update` card, and the turn it
 * resumed wrote «Я перенастроил вашу задачу на 8 октября, 09:20». A setting
 * Bro keeps outside memory — the form of address, the spend limit, Personal
 * Info — is remembered too («Запомнил: на «вы»»), and a reminder of an event
 * is set with the event.
 */
const acts = ["email", "memory", "message", "order", "schedule"] as const;

type Act = (typeof acts)[number];

const actTools: Record<Act, readonly string[]> = {
  email: ["gmail-draft", "gmail-send"],
  memory: [
    "form_of_address",
    "personal_info__update",
    "profile__forget_all",
    "profile__remove_memory",
    "profile__save_memory",
    "profile__update",
    "spend_limit",
    "standing_permission",
    "workstreams__forget",
    "workstreams__forget_all",
    "workstreams__save",
  ],
  message: ["slack-send-message"],
  order: ["browser_task"],
  schedule: [
    ...calendarWriteTools,
    "proactive_messages",
    "schedules-create",
    "schedules-update",
  ],
};

/**
 * The calls in `messages` the person declined on an approval card. A
 * policy's own refusal is written as an automatic request: nobody saw a card.
 */
function declinedCards(messages: readonly ModelMessage[]) {
  const cards = new Map<string, string>();
  const declined = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-request" && part.isAutomatic !== true) {
        cards.set(part.approvalId, part.toolCallId);
      }
      const call =
        part.type === "tool-approval-response" && !part.approved
          ? cards.get(part.approvalId)
          : undefined;
      if (call) declined.add(call);
    }
  }
  return declined;
}

/**
 * No call of an action yet: none went through, was declined on its card or
 * refused otherwise in this turn, and none was made before it.
 */
function noCalls() {
  return {
    declined: false,
    done: false,
    earlierCall: false,
    earlierDone: false,
    lastRefused: false,
    refused: false,
  };
}

/**
 * What came of the calls of each action: whether one went through in this
 * turn, whether one was declined on its card, or refused by a policy or
 * failed, in this turn; whether one was made before it, and whether one
 * went through; and whether the last of them, made in the turn right before
 * this one, did not go through. The `apps` tool runs any app's action, so
 * one that went through counts for every action.
 */
function actOutcomes(
  turn: readonly ModelMessage[],
  earlier: readonly ModelMessage[],
  previousTurn: readonly ModelMessage[]
) {
  const outcomes: Record<Act, ReturnType<typeof noCalls>> = {
    email: noCalls(),
    memory: noCalls(),
    message: noCalls(),
    order: noCalls(),
    schedule: noCalls(),
  };
  const previousCalls = new Set(
    toolResults(previousTurn).map((part) => part.toolCallId)
  );
  for (const part of toolResults(earlier)) {
    for (const act of acts) {
      if (!actTools[act].includes(part.toolName)) continue;
      outcomes[act].earlierCall = true;
      if (succeeded(part.output)) outcomes[act].earlierDone = true;
      outcomes[act].lastRefused =
        !succeeded(part.output) && previousCalls.has(part.toolCallId);
    }
  }
  const declined = declinedCards(turn);
  for (const part of toolResults(turn)) {
    const ran = part.toolName === "apps" && succeeded(part.output);
    for (const act of acts) {
      if (ran) outcomes[act].done = true;
      if (!actTools[act].includes(part.toolName)) continue;
      if (succeeded(part.output)) outcomes[act].done = true;
      else if (declined.has(part.toolCallId)) outcomes[act].declined = true;
      else outcomes[act].refused = true;
    }
  }
  return outcomes;
}

/**
 * What the current turn has done that a message could claim. `turn` is the
 * turn after its opening message, `earlier` everything before that message.
 * A turn a background prompt opened — a browser run's report, a scheduled
 * result — relays what happened elsewhere, so its browser claims and its
 * claims of actions no call made are not checked; a call it declined or
 * failed still is. `previousTurn` is the turn right before this one, and
 * `request` the person's own message that opened this turn, if they did.
 */
export function turnActions(
  turn: readonly ModelMessage[],
  earlier: readonly ModelMessage[],
  options: {
    readonly background: boolean;
    readonly previousTurn: readonly ModelMessage[];
    readonly request: string | undefined;
  }
) {
  let browserPending = false;
  let codeTyped = false;
  let calendarWritten = false;
  let calendarRefused = false;
  let reminderSet = false;
  const appsCalls = appsCalendarCalls([...earlier, ...turn]);
  for (const part of toolResults(turn)) {
    if (!succeeded(part.output)) {
      if (calendarWriteTools.has(part.toolName)) calendarRefused = true;
      continue;
    }
    if (wroteCalendar(part, appsCalls)) calendarWritten = true;
    if (part.toolName === "schedules-create") reminderSet = true;
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
    acts: actOutcomes(turn, earlier, options.previousTurn),
    background: options.background,
    browserPending: browserPending && !options.background,
    calendarRefused,
    calendarWritten,
    calendarWrittenEarlier: toolResults(earlier).some((part) =>
      wroteCalendar(part, appsCalls)
    ),
    codeTyped,
    reminderSet,
    request: options.request
      ?.normalize("NFKC")
      .toLocaleLowerCase()
      .replaceAll("ё", "е"),
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

/** The same, said as still to come. */
const calendarFutureVerbs = [
  "поставлю",
  "добавлю",
  "внесу",
  "занесу",
  "создам",
  "запишу",
  "перенесу",
  "will",
  "ll",
];

const calendarNoun = /календар|событи|calendar/u;

const reminderNoun = /напоминани|reminder/u;

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

/**
 * A message's clauses, for a claim of an action: its sentences split again
 * at a dash or a colon («Готово: отправил письмо», «перенастроил задачу на
 * 09:20 — тогда открою регистрацию»), without those about another time.
 */
function clausesOf(text: string) {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll("ё", "е")
    .split(/[.!?…;:\n]+|\s[—–-]\s/u)
    .filter((clause) => !otherTime.test(clause));
}

function wordsOf(sentence: string) {
  return sentence.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function nounsOf(words: readonly string[], noun = calendarNoun) {
  return words.flatMap((word, index) => (noun.test(word) ? [index] : []));
}

const calendarVerbs = new Set([
  ...calendarFutureVerbs,
  ...calendarPastVerbs,
  ...calendarPresentVerbs,
]);

/**
 * Whether every mention of the calendar in a sentence is what a promise puts
 * there: «записал тебя к терапевту на пт 10:00 — добавлю в календарь, как
 * подтвердишь» tells the booking a site made and the calendar entry still to
 * come, and claims no write. The verb nearest before each mention decides,
 * so «добавил в календарь и поставлю напоминание» still claims one. The same
 * reads a reminder promised by its own noun.
 */
function promisesStep(sentence: string, nounPattern = calendarNoun) {
  const words = wordsOf(sentence);
  const nouns = nounsOf(words, nounPattern);
  return (
    nouns.length > 0 &&
    nouns.every((noun) => {
      const verb = words
        .slice(Math.max(0, noun - 5), noun)
        .findLast((word) => calendarVerbs.has(word));
      return verb !== undefined && calendarFutureVerbs.includes(verb);
    })
  );
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
  const words = wordsOf(sentence);
  const nouns = nounsOf(words);
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
 * A promise that waits on something: the person («назовите время —
 * поставлю», «как подтвердите»), the run («как придёт корзина», «как заказ
 * оформится», «после оплаты») or a later moment («потом добавлю»).
 */
const onCondition =
  /(?<!\p{L})(?:если|когда|как только|как\s+\p{L}+|после|потом|позже|затем|once|if|when|after|later|then)(?!\p{L})/u;

/** What the person asked to have put in their calendar or reminded of. */
const calendarAsked = /календар|calendar/u;
const reminderAsked = /напомн|напоминан|remind/u;

/**
 * Whether a message promises, for right now, a step the person asked for in
 * this turn that no tool has taken yet: «сейчас поставлю приём доставки в
 * календарь» after «…и поставь в календарь». A message that only announces
 * it would be dropped as adding nothing, and the turn would end before the
 * step was taken. A step nobody asked for, or one that waits on the person,
 * the run or a later moment, is left alone: sent back, the model would make
 * it now, at a time it guessed. `request` is the person's message, as a
 * sent message's normalized text.
 */
export function promisesUntakenStep(
  text: string,
  actions: ReturnType<typeof turnActions>,
  request: string
) {
  const calendar = !actions.calendarWritten && calendarAsked.test(request);
  const reminder = !actions.reminderSet && reminderAsked.test(request);
  return sentencesOf(text).some(
    (sentence) =>
      !onCondition.test(sentence) &&
      requestsOf(sentence).length === 0 &&
      ((calendar && promisesStep(sentence)) ||
        (reminder && promisesStep(sentence, reminderNoun)))
  );
}

/**
 * A person asking, in the imperative, to remember or forget something, or
 * how to call them. «Ты запомнил, что я не ем мясо?» asks about a record,
 * maybe one another chat saved: a «Да, запомнил» is not checked.
 */
const memoryAsked =
  /запомни(?!л)|забудь|забыть|удали|сотри|на «?вы|на «?ты|обращайся|remember (?:that|this|my|i)|forget/u;

/**
 * How each action is said as done: one of its verbs in the past, opening a
 * clause, with one of its nouns within three words after it — «перенастроил
 * вашу задачу», «отправил письмо Иванову» — or on its own where the verb
 * names the action. A claim with no call of the action at all is checked
 * only when the person's own message of this turn asked for it (`asked`):
 * «Да, запомнил» about a record another chat saved, or a recap the history
 * no longer holds, is left alone. The rest are checked only against a call
 * that did not go through, since «задача» is also a browser run's or
 * Notion's, and an order is the run's to report.
 */
const actClaims: readonly {
  readonly act: Act;
  readonly asked?: RegExp;
  readonly noun?: RegExp;
  readonly verbs: readonly string[];
}[] = [
  {
    act: "schedule",
    asked:
      /напомни(?!л)|напомните|присылай|заведи|поставь|перенеси|сдвинь|останови|отмени|удали|кажд|ежедн|по будням|remind|schedule|every/u,
    noun: /напоминани|расписани|reminder|schedule/u,
    verbs: [
      "поставил",
      "настроил",
      "перенастроил",
      "перенес",
      "сдвинул",
      "создал",
      "завел",
      "изменил",
      "поменял",
      "удалил",
      "отменил",
      "остановил",
      "выключил",
      "убрал",
      "set",
      "scheduled",
      "moved",
      "changed",
      "updated",
      "deleted",
      "cancelled",
      "canceled",
    ],
  },
  {
    act: "schedule",
    noun: /задач/u,
    verbs: [
      "перенастроил",
      "перенес",
      "сдвинул",
      "изменил",
      "поменял",
      "удалил",
      "отменил",
      "остановил",
      "выключил",
    ],
  },
  {
    // «Написал письмо Иванову: …» is as often a draft in the chat.
    act: "email",
    asked: /отправь|напиши|ответь|перешли|send|reply|forward|write/u,
    noun: /письм|email|e-mail/u,
    verbs: ["отправил", "ответил", "переслал", "sent", "replied", "forwarded"],
  },
  {
    act: "message",
    asked: /slack|слак/u,
    noun: /slack|слак/u,
    verbs: ["отправил", "написал", "sent", "posted"],
  },
  {
    act: "memory",
    asked: memoryAsked,
    noun: /памят|memory/u,
    verbs: [
      "сохранил",
      "записал",
      "удалил",
      "стер",
      "убрал",
      "очистил",
      "saved",
      "deleted",
      "erased",
      "cleared",
    ],
  },
  { act: "memory", asked: memoryAsked, verbs: ["запомнил", "remembered"] },
  {
    act: "order",
    verbs: [
      "заказал",
      "оформил заказ",
      "забронировал",
      "оплатил",
      "купил",
      "записал вас",
      "записал тебя",
      "booked",
      "ordered",
      "paid",
      "bought",
    ],
  },
];

/**
 * Words a clause may open with before Bro's own verb. Russian says the past
 * alike for everyone, so «Иванов отправил письмо» from the inbox is somebody
 * else's act: only a clause that opens with the verb, or with «я» and words
 * like these, says what Bro did.
 */
const leadWords = new Set([
  "я",
  "i",
  "и",
  "а",
  "да",
  "вот",
  "так",
  "итак",
  "уже",
  "только",
  "что",
  "сейчас",
  "сразу",
  "заодно",
  "также",
  "тоже",
  "еще",
  "все",
  "готово",
  "ок",
  "окей",
  "хорошо",
  "отлично",
  "кстати",
  "and",
  "also",
  "already",
  "have",
  "ve",
  "just",
  "now",
  "ok",
  "okay",
  "done",
  "yes",
]);

/**
 * Whether a clause opens with one of `verbs` as Bro's own act, with a `noun`
 * within three words after it when the action has one.
 */
function saysAct(
  clause: string,
  verbs: readonly string[],
  noun: RegExp | undefined
) {
  const words = wordsOf(clause);
  const start = words.findIndex((word) => !leadWords.has(word));
  if (start === -1) return false;
  return verbs.some((verb) => {
    const phrase = wordsOf(verb);
    if (!phrase.every((word, offset) => words[start + offset] === word)) {
      return false;
    }
    const end = start + phrase.length - 1;
    return (
      noun === undefined ||
      words.some((word, at) => at > end && at - end <= 3 && noun.test(word))
    );
  });
}

/**
 * Why a message's claim of an action is untrue, or nothing: its call was
 * declined on its card, refused or failed in this turn; or it was the last
 * call of the action, made in the turn right before, and no call of it ever
 * went through; or, in a turn the person opened and asking for the action,
 * no call of it was made at all. A claim is left alone once a call of it
 * went through in this turn, or an earlier one did: the message may recap
 * that. An order is checked only against a card the person declined in
 * their own turn: a report's turn tells what the run did, whatever a later
 * call there met.
 */
function actClaim(text: string, actions: ReturnType<typeof turnActions>) {
  const clauses = clausesOf(text);
  for (const { act, asked, noun, verbs } of actClaims) {
    if (!clauses.some((clause) => saysAct(clause, verbs, noun))) continue;
    const outcome = actions.acts[act];
    if (outcome.done) continue;
    if (act === "order") {
      if (outcome.declined && !actions.background) return "declined";
      continue;
    }
    // «Остановил задачу» after a browser run was stopped in this turn.
    if (!asked && actions.acts.order.done) continue;
    if (
      outcome.declined ||
      outcome.refused ||
      (outcome.lastRefused && !outcome.earlierDone)
    ) {
      return "declined";
    }
    if (
      asked?.test(actions.request ?? "") &&
      !actions.background &&
      !outcome.earlierCall
    ) {
      return "undone";
    }
  }
  return undefined;
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
    // («Записал: встреча в пятницу в календаре»), unless the calendar there
    // is only promised; a present one only next to the calendar.
    const claimed = sentences.some((sentence) => {
      const own = sentence.replaceAll(theirCalendar, "");
      if (!calendarNoun.test(own)) return false;
      return (
        saysNearCalendar(own, calendarPresentVerbs) ||
        (!actions.calendarWrittenEarlier &&
          !promisesStep(own) &&
          says(sentence, calendarPastVerbs))
      );
    });
    if (claimed) return actions.calendarRefused ? "declined" : "calendar";
  }
  return actClaim(text, actions);
}

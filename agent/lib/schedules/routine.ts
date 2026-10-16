import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import {
  currentTurnMessages,
  sendReachedPerson,
} from "@agent/lib/delivery/turn-sends";
import type { resolveModeValue } from "@agent/lib/mode";
import { env } from "@shared/environment";
import type { ScheduleTiming } from "@shared/schedules/timing";

type ModeContext = Parameters<typeof resolveModeValue>[0];

/**
 * Whether a workspace sets up a routine whole (ROUTINE_SETUP_WORKSPACES): a
 * new summary runs once right away as a trial, and a schedule like an
 * active one waits for the person's word. Ids only, or `*`, so the verdict
 * needs no lookup.
 */
function routineSetupPilot(workspaceId: string) {
  const list = env.ROUTINE_SETUP_WORKSPACES ?? [];
  return list.includes("*") || list.includes(workspaceId);
}

/** The workspace of this turn's caller, when it is a person's. */
function callerWorkspace(context: ModeContext) {
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") return undefined;
  return z.string().min(1).safeParse(caller.attributes.workspaceId).data;
}

/** Whether this turn's workspace is in the pilot, whoever started the turn. */
export function routineSetupOfCaller(context: ModeContext) {
  const workspaceId = callerWorkspace(context);
  return workspaceId !== undefined && routineSetupPilot(workspaceId);
}

type CalendarTiming = Extract<ScheduleTiming, { kind: "calendar" }>;

/**
 * How far apart two runs may be on the clock and still be one routine's
 * time: a summary at 7:00 and one at 8:00 on weekdays are the same morning.
 */
const nearMinutes = 60;

const everyDay = [0, 1, 2, 3, 4, 5, 6];
const workDays = [1, 2, 3, 4, 5];
const weekMinutes = 7 * 1_440;

function minutesOf(localTime: string) {
  return Number(localTime.slice(0, 2)) * 60 + Number(localTime.slice(3, 5));
}

/** The days of the week a rule of days runs on; none for a month's rule. */
function weekDaysOf(timing: CalendarTiming) {
  switch (timing.frequency) {
    case "daily":
      return everyDay;
    case "weekdays":
      return workDays;
    case "weekly":
      return "weekdays" in timing ? timing.weekdays : [timing.weekday];
    default:
      return undefined;
  }
}

/**
 * When a rule of days runs, in minutes from Sunday 00:00: Monday 23:30 and
 * Tuesday 00:10 are 40 minutes apart, Monday 00:10 and Monday 23:30 are not.
 */
function weekMinutesOf(timing: CalendarTiming) {
  const at = minutesOf(timing.localTime);
  return weekDaysOf(timing)?.map((day) => day * 1_440 + at);
}

/** The day of a month's or a year's rule, as one comparable key. */
function monthDayOf(timing: CalendarTiming) {
  switch (timing.frequency) {
    case "monthly":
      return JSON.stringify([timing.frequency, timing.dayOfMonth]);
    case "monthly_weekday":
      return JSON.stringify([
        timing.frequency,
        timing.occurrence,
        timing.weekday,
      ]);
    case "yearly":
      return JSON.stringify([
        timing.frequency,
        timing.month,
        timing.dayOfMonth,
      ]);
    default:
      return undefined;
  }
}

/** Whether two calendar rules run within an hour of each other. */
function calendarNear(left: CalendarTiming, right: CalendarTiming) {
  if (left.timezone !== right.timezone) return false;
  const leftWeek = weekMinutesOf(left);
  const rightWeek = weekMinutesOf(right);
  if (leftWeek && rightWeek) {
    return leftWeek.some((at) =>
      rightWeek.some((other) => {
        const apart = Math.abs(at - other);
        return Math.min(apart, weekMinutes - apart) <= nearMinutes;
      })
    );
  }
  return (
    leftWeek === undefined &&
    rightWeek === undefined &&
    monthDayOf(left) === monthDayOf(right) &&
    Math.abs(minutesOf(left.localTime) - minutesOf(right.localTime)) <=
      nearMinutes
  );
}

/**
 * Whether two rules run at one time: calendar rules within an hour of each
 * other, fixed intervals of the same length.
 */
function nearInTime(left: ScheduleTiming, right: ScheduleTiming) {
  if (left.kind === "calendar" && right.kind === "calendar") {
    return calendarNear(left, right);
  }
  return (
    left.kind === "interval" &&
    right.kind === "interval" &&
    left.everyMinutes === right.everyMinutes
  );
}

/**
 * Words that say when and how often a run goes, or that it is sent, rather
 * than what it gathers: «каждое утро присылай курс доллара» and «каждое утро
 * присылай погоду» share only these.
 */
const framingStart =
  /^(?:кажд|ежедн|еженед|ежемес|утр|вечер|будн|выходн|недел|понедельн|вторн|четверг|пятниц|суббот|воскрес|сегодн|завтр|присыл|пришл|отправ|напомин|напомн|сообщ|провер|котор|every|daily|weekly|monthly|morning|evening|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|send|remind|check)/u;

const framingWords = new Set([
  "день",
  "дня",
  "днём",
  "днем",
  "среда",
  "среду",
  "меня",
  "если",
  "когда",
  "чтобы",
  "each",
  "with",
  "that",
  "this",
  "from",
  "about",
  "what",
  "which",
  "still",
  "have",
  "your",
  "please",
  "when",
]);

function fold(text: string) {
  return text.toLowerCase().replaceAll("ё", "е");
}

/**
 * A word's stem, without its ending: two letters off a long word, one off a
 * word of four or five («сводка», «сводку» → «свод»; «письма» → «пись»).
 */
function stem(word: string) {
  return word.length > 5 ? word.slice(0, -2) : word.slice(0, -1);
}

/** The stems of what a prompt asks for, without its framing. */
function contentStems(prompt: string) {
  const words = fold(prompt).match(/\p{L}+/gu) ?? [];
  return new Set(
    words
      .filter(
        (word) =>
          word.length >= 4 &&
          !framingWords.has(word) &&
          !framingStart.test(word)
      )
      .map(stem)
  );
}

/**
 * Whether two prompts ask for mostly the same: at least two stems in common,
 * half of the shorter one's. «Сводка: календарь, письма без ответа, погода»
 * and «утром пришли календарь, погоду и письма» are; «пить воду» and «пить
 * таблетки» are not.
 */
function nearInWords(left: string, right: string) {
  if (fold(left).trim() === fold(right).trim()) return true;
  const leftStems = contentStems(left);
  const rightStems = contentStems(right);
  const shared = [...leftStems].filter((part) => rightStems.has(part)).length;
  return shared >= 2 && shared * 2 >= Math.min(leftStems.size, rightStems.size);
}

/**
 * The person's active recurring schedules a new recurring one may repeat.
 * `alike` run at one time and ask for mostly the same. Time alone is no
 * repeat — «в 8:00 омепразол, в 8:30 эналаприл» are two reminders — and
 * neither are words alone: a summary in the evening is not the morning one.
 * A routine that gathers something (`gathers`) also has `nearby`, the others
 * at one time, for the model to compare: words do not cross languages, and
 * an English summary next to a Russian one shares none (EN D7). A one-off
 * reminder is never one, and is never held up by one.
 */
export function similarSchedules<
  Job extends {
    readonly prompt: string;
    readonly status: string;
    readonly timing: ScheduleTiming;
  },
>(
  fresh: { readonly prompt: string; readonly timing: ScheduleTiming },
  jobs: readonly Job[],
  gathers: boolean
) {
  if (fresh.timing.kind === "once") return { alike: [], nearby: [] };
  const near = jobs.filter(
    (job) =>
      job.status === "active" &&
      job.timing.kind !== "once" &&
      nearInTime(fresh.timing, job.timing)
  );
  const alike = near.filter((job) => nearInWords(fresh.prompt, job.prompt));
  return {
    alike,
    nearby: gathers ? near.filter((job) => !alike.includes(job)) : [],
  };
}

/** How `schedules-create` opens a refusal over a schedule like the new one. */
export const similarRefusalOpening =
  "Nothing was created: the person already has an active schedule";

function resultText(output: ToolResultPart["output"]) {
  switch (output.type) {
    case "error-text":
    case "text":
      return output.value;
    case "error-json":
    case "json":
      return JSON.stringify(output.value);
    default:
      return "";
  }
}

function refusedAsSimilar(message: ModelMessage) {
  return (
    message.role === "tool" &&
    message.content.some(
      (part) =>
        part.type === "tool-result" &&
        part.toolName === "schedules-create" &&
        resultText(part.output).includes(similarRefusalOpening)
    )
  );
}

const sentTextSchema = z.object({ text: z.string() });

/** The texts of the messages that reached the person. */
function deliveredTexts(messages: readonly ModelMessage[]) {
  const delivered = new Set(
    messages.flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result" &&
            part.toolName === "send_message" &&
            sendReachedPerson(part.output)
              ? [part.toolCallId]
              : []
          )
        : []
    )
  );
  return messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === "tool-call" &&
          part.toolName === "send_message" &&
          delivered.has(part.toolCallId)
            ? [sentTextSchema.safeParse(part.input).data?.text ?? ""]
            : []
        )
      : []
  );
}

/**
 * Whether this turn put a schedule like one the person has to them — a
 * `schedules-create` refused over it, then a question that reached them —
 * so that whether to replace it or keep both is theirs to say, in their
 * next message. Until then `schedules-create` waits, as the actions a
 * question holds do (`turnAwaitsAnswer`): with `replaces` it deletes. A
 * message sent in the refused call's own step was written before the
 * refusal, and one that asks nothing («Сейчас настрою») holds nothing.
 */
export function routineAnswerOwed(messages: readonly ModelMessage[]) {
  const turn = currentTurnMessages(messages);
  const refused = turn.findLastIndex(refusedAsSimilar);
  return (
    refused !== -1 &&
    deliveredTexts(turn.slice(refused + 1)).some((text) => /[?？]/u.test(text))
  );
}

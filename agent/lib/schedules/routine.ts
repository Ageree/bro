import { z } from "zod";
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
 * time. EN D7: a second morning summary was made over the one the person
 * had, and two summaries in two languages share no words, only the morning.
 */
const nearMinutes = 60;

const everyDay = [0, 1, 2, 3, 4, 5, 6];
const workDays = [1, 2, 3, 4, 5];

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

/** Whether two calendar rules ever run on the same day. */
function shareDays(left: CalendarTiming, right: CalendarTiming) {
  const leftDays = weekDaysOf(left);
  const rightDays = weekDaysOf(right);
  if (leftDays && rightDays) {
    return leftDays.some((day) => rightDays.includes(day));
  }
  return (
    leftDays === undefined &&
    rightDays === undefined &&
    monthDayOf(left) === monthDayOf(right)
  );
}

/**
 * Whether two rules run on a same day within an hour of each other on one
 * clock. A fixed interval has no time of day: only its words compare.
 */
function nearInTime(left: ScheduleTiming, right: ScheduleTiming) {
  if (left.kind !== "calendar" || right.kind !== "calendar") return false;
  if (left.timezone !== right.timezone) return false;
  const apart = Math.abs(
    minutesOf(left.localTime) - minutesOf(right.localTime)
  );
  return (
    Math.min(apart, 1_440 - apart) <= nearMinutes && shareDays(left, right)
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
 * The person's active recurring schedules a new recurring one is like: on
 * a same day within an hour of it, or asking for mostly the same. A one-off
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
  jobs: readonly Job[]
) {
  if (fresh.timing.kind === "once") return [];
  return jobs.filter(
    (job) =>
      job.status === "active" &&
      job.timing.kind !== "once" &&
      (nearInTime(fresh.timing, job.timing) ||
        nearInWords(fresh.prompt, job.prompt))
  );
}

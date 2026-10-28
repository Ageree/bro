import * as z from "zod";
import { labelSaid } from "@agent/lib/location/words";
import { readRememberedConversations } from "@db/services/proactive";
import {
  createScheduledAgentJob,
  getScheduledAgentJob,
  reportConversations,
} from "@db/services/scheduled-agent-jobs";
import { isSessionOwned } from "@db/services/sessions";
import type { AccessScope } from "@shared/identity/access-scope";
import { resolveScheduleTiming } from "@shared/schedules/timing";
import { voiceLinePattern } from "@shared/voice/marker";

// A one-off reminder the voice of /talk sets itself (VOICE_QUICK_WORKSPACES): «напомни завтра в 9
// позвонить маме» took Bro's whole turn, 8–10 s, the commonest errand said aloud. Only a one-off at a time
// the person named, about what they said: a repeating one, one with a condition or one that acts goes to
// Bro, whose schedules tool asks about duplicates and holds actions to the person's turn
// (`agent/tools/schedules.ts`). The line the voice says is built here, not by the model: no second step,
// and no «поставил» for a reminder that was not made.

export const remindInputSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("О чём напомнить — словами человека: «позвонить маме»."),
  inMinutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional()
    .describe(
      "Для «через N минут/часов»: «через час» — 60. Код считает от этой минуты."
    ),
  at: z
    .string()
    .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/u)
    .optional()
    .describe(
      "Для времени по часам: YYYY-MM-DDTHH:MM по часам человека, «завтра в 9» — дата завтра и 09:00."
    ),
});

type RemindInput = z.infer<typeof remindInputSchema>;

/** A reminder the quick answer may not set: the words go to Bro. */
export class RemindRefusal extends Error {
  override name = "RemindRefusal";
}

/** The person asked for a reminder in their own words. */
const reminderAsked = /(?<!\p{L})(?:напомн|напоминани|remind)/iu;
/** A moment named: «через час», «завтра», «в 9», «в девять вечера», a weekday. */
const momentNamed =
  /\d|(?<!\p{L})(?:через|завтра|сегодня|послезавтра|утр|вечер|днём|днем|ноч|полдень|полночь|понедельник|вторник|сред[уа]|четверг|пятниц|суббот|воскресень|час|минут|один|два|две|три|четыр|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)/iu;
/**
 * What only Bro sets: a condition («если дождь»), a repeat («каждый день», «по будням»), an alarm or an
 * event in the calendar. Bro's schedules tool asks about duplicates and holds conditions and actions.
 */
const notOneOff =
  /(?<!\p{L})(?:если|когда|кажд|ежедн|еженед|по будням|по выходным|будильник|календар)/iu;
/** A reminder of «об этом» names nothing its run could tell. */
const pointers = new Set([
  "об",
  "о",
  "про",
  "это",
  "этом",
  "этого",
  "том",
  "то",
  "нем",
  "нём",
  "ней",
  "них",
  "всё",
  "все",
  "этих",
]);

/**
 * Whether the person's own words (the voice's lines left out) are a plain one-off reminder the quick
 * answer may set itself: asked for, with a moment, no condition, repeat, alarm or calendar, and nothing
 * else asked beside it («какая погода? если дождь — напомни» goes to Bro whole, or the reminder would be
 * lost to the weather answer). Code decides, not the model: it dropped such a reminder or set one with a
 * time no one named (review 28.10).
 */
export function plainReminder(own: string) {
  return (
    reminderAsked.test(own) &&
    momentNamed.test(own) &&
    !notOneOff.test(own) &&
    !own.includes("?")
  );
}

/** The person mentioned a reminder at all: what is not `plainReminder` then goes to Bro. */
export function reminderMentioned(own: string) {
  return reminderAsked.test(own);
}

/** The same reminder asked twice within this long is made once, while its job stands. */
const repeatMs = 10 * 60_000;
const made = new Map<
  string,
  { readonly at: number; readonly jobId: string; readonly line: string }
>();

const channelWords = {
  eve: "в чат",
  photon: "в iMessage",
  telegram: "в Telegram",
} as const;

/** «завтра в 09:00», «сегодня в 18:30», «31 октября в 10:00» on the person's clock. */
function spokenWhen(at: Date, now: Date, timeZone: string) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone });
  const time = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(at);
  const today = day.format(now);
  const tomorrow = day.format(new Date(now.getTime() + 24 * 60 * 60_000));
  const date = day.format(at);
  if (date === today) return `сегодня в ${time}`;
  if (date === tomorrow) return `завтра в ${time}`;
  const label = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone,
  }).format(at);
  return `${label} в ${time}`;
}

/** The chat the reminder is made in: the page's own Bro chat, else the person's last web chat. */
async function madeIn(scope: AccessScope, chat: string | undefined) {
  if (chat !== undefined && (await isSessionOwned(scope, chat))) return chat;
  return (
    (await readRememberedConversations(scope.workspaceId))?.webConversationId ??
    undefined
  );
}

/** Where its runs report, named for the voice; a failed lookup leaves it out. */
async function deliveredTo(job: Parameters<typeof reportConversations>[0]) {
  try {
    const { delivery } = await reportConversations(job);
    return ` Придёт ${channelWords[delivery.conversationChannel]}.`;
  } catch {
    return "";
  }
}

/**
 * Sets the reminder and gives the line the voice says, or throws a `RemindRefusal`: not a plain one-off
 * reminder in the person's words, a text they did not say, no time, no chat to make it in, a moment past.
 */
export async function remindOnce(
  scope: AccessScope,
  input: RemindInput,
  context: {
    readonly chat: string | undefined;
    readonly now: Date;
    readonly signal: AbortSignal;
    readonly timeZone: string;
    readonly words: string;
  }
) {
  // The model writes what to remind of; it must be what the person said.
  const own = context.words.replaceAll(voiceLinePattern, " ");
  if (!plainReminder(own))
    throw new RemindRefusal("Not a plain one-off reminder.");
  const named = input.text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "" && !pointers.has(word));
  if (named.length === 0 || !labelSaid(input.text, [own]))
    throw new RemindRefusal("The reminder is not in the person's words.");
  // Weak models fill every field: with both, the person's «через» picks.
  const relative =
    input.inMinutes !== undefined &&
    (input.at === undefined || /(?<!\p{L})через(?!\p{L})/iu.test(own));
  if (!relative && input.at === undefined)
    throw new RemindRefusal("A reminder needs a time.");
  const timing = resolveScheduleTiming(
    relative
      ? { inMinutes: input.inMinutes ?? 0, kind: "relative" }
      : { at: input.at ?? "", kind: "once" },
    context.timeZone
  );
  if (timing.kind !== "once" || Date.parse(timing.at) <= context.now.getTime())
    throw new RemindRefusal("The reminder's moment has passed.");
  const prompt = `Напомни человеку: ${input.text}`;
  const key = `${scope.workspaceId}|${prompt}|${timing.at}`;
  const earlier = made.get(key);
  if (earlier && context.now.getTime() - earlier.at < repeatMs) {
    // Bro may have cancelled or moved it since.
    const job = await getScheduledAgentJob(scope, earlier.jobId);
    if (job?.status === "active" && job.nextRunAt?.toISOString() === timing.at)
      return earlier.line;
  }
  const conversationId = await madeIn(scope, context.chat);
  if (conversationId === undefined)
    throw new RemindRefusal("No chat to make the reminder in.");
  // A conversation that ended before this point makes nothing.
  if (context.signal.aborted)
    throw new RemindRefusal("The conversation ended.");
  const job = await createScheduledAgentJob(scope, {
    conversationChannel: "eve",
    conversationId,
    missedRunPolicy: "run_latest",
    prompt,
    timing,
  });
  const line = `Поставил напоминание ${spokenWhen(job.nextRunAt ?? new Date(timing.at), context.now, context.timeZone)}: ${input.text}.${await deliveredTo(job)}`;
  made.set(key, { at: context.now.getTime(), jobId: job.id, line });
  return line;
}

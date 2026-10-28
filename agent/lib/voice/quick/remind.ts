import * as z from "zod";
import { textSaid } from "@agent/lib/location/words";
import { readRememberedConversations } from "@db/services/proactive";
import {
  createScheduledAgentJob,
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

/** The same reminder asked twice within this long is made once. */
const repeatMs = 10 * 60_000;
const made = new Map<string, { readonly line: string; readonly at: number }>();

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

/**
 * Sets the reminder and gives the line the voice says, or throws a `RemindRefusal`: no time or both, a
 * reminder about words the person did not say, no chat to make it in, a moment past.
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
  if ((input.inMinutes === undefined) === (input.at === undefined))
    throw new RemindRefusal("A reminder needs one time: inMinutes or at.");
  // The model writes what to remind of; it must be what the person said.
  const own = context.words.replaceAll(voiceLinePattern, " ");
  if (!textSaid(input.text, [own]))
    throw new RemindRefusal("The reminder is not in the person's words.");
  const timing = resolveScheduleTiming(
    input.inMinutes === undefined
      ? { at: input.at ?? "", kind: "once" }
      : { inMinutes: input.inMinutes, kind: "relative" },
    context.timeZone
  );
  if (timing.kind !== "once" || Date.parse(timing.at) <= context.now.getTime())
    throw new RemindRefusal("The reminder's moment has passed.");
  const prompt = `Напомни человеку: ${input.text}`;
  const key = `${scope.workspaceId}|${prompt}|${timing.at}`;
  const earlier = made.get(key);
  if (earlier && context.now.getTime() - earlier.at < repeatMs)
    return earlier.line;
  const conversationId = await madeIn(scope, context.chat);
  if (conversationId === undefined)
    throw new RemindRefusal("No chat to make the reminder in.");
  // A conversation that ended before this point makes nothing: its words go
  // to Bro, which would make it again.
  if (context.signal.aborted)
    throw new RemindRefusal("The conversation ended.");
  const job = await createScheduledAgentJob(scope, {
    conversationChannel: "eve",
    conversationId,
    missedRunPolicy: "run_latest",
    prompt,
    timing,
  });
  const { delivery } = await reportConversations(job);
  const line = `Поставил напоминание ${spokenWhen(job.nextRunAt ?? new Date(timing.at), context.now, context.timeZone)}: ${input.text}. Придёт ${channelWords[delivery.conversationChannel]}.`;
  made.set(key, { line, at: context.now.getTime() });
  return line;
}

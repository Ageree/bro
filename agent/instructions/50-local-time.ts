import { defineDynamic, defineInstructions } from "eve/instructions";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { readWorkspaceTimeZone } from "@db/services/user-profile";

/**
 * What time it is where the person is. Without it the model dates «сегодня»
 * and «завтра» from whatever it guesses, and every schedule, delivery window
 * and «во сколько» it derives from that guess is wrong by a working day.
 */
export function localTimeInstructions(
  now: Date,
  timeZone: string,
  canSaveTimeZone = true
) {
  const localTime = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(now);
  const clock = `Сейчас у человека ${localTime} (таймзона ${timeZone}). Считай «сегодня», «завтра» и «на выходных» от этого времени, а не от чего-то своего.`;
  if (!canSaveTimeZone) return clock;
  return [
    clock,
    "Если он называет город или таймзону, а в Personal Info её нет или она другая — сохрани поле `timezone` через `personal_info__update` именем зоны IANA, например Europe/Moscow.",
  ].join("\n");
}

export default defineDynamic({
  events: {
    async "turn.started"(_event, context) {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      // Bro's own checks read the clock but have no profile to write to, and
      // neither does a report turn, which still has to say «завтра в 07:05»
      // and «выйти в 04:30» on the person's clock rather than UTC.
      const canSaveTimeZone = resolveModeValue(context, {
        interactive: true,
        "proactive-worker": false,
        "scheduled-report": false,
        "scheduled-worker": true,
      });
      if (
        caller?.principalType !== "user" ||
        !z.string().safeParse(caller.attributes.workspaceId).success ||
        canSaveTimeZone === null
      ) {
        return null;
      }
      return defineInstructions({
        content: localTimeInstructions(
          new Date(),
          await readWorkspaceTimeZone(scopeFromPrincipal(caller)),
          canSaveTimeZone
        ),
      });
    },
  },
});

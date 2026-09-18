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
export function localTimeInstructions(now: Date, timeZone: string) {
  const localTime = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(now);
  return [
    `Сейчас у человека ${localTime} (таймзона ${timeZone}). Считай «сегодня», «завтра» и «на выходных» от этого времени, а не от чего-то своего.`,
    "Если он называет город или таймзону, а в Personal Info её нет или она другая — сохрани поле `timezone` через `personal_info__update` именем зоны IANA, например Europe/Moscow.",
  ].join("\n");
}

export default defineDynamic({
  events: {
    async "turn.started"(_event, context) {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (
        caller?.principalType !== "user" ||
        !z.string().safeParse(caller.attributes.workspaceId).success ||
        resolveModeValue(context, {
          interactive: true,
          "scheduled-worker": true,
        }) !== true
      ) {
        return null;
      }
      return defineInstructions({
        content: localTimeInstructions(
          new Date(),
          await readWorkspaceTimeZone(scopeFromPrincipal(caller))
        ),
      });
    },
  },
});

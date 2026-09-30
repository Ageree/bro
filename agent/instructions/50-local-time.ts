import { defineDynamic, defineInstructions } from "eve/instructions";
import { z } from "zod";
import {
  clockModes,
  localClock,
  saveTimeZoneInstruction,
} from "@agent/lib/local-time";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { stepNoteInstructions } from "@agent/lib/step-context/note";
import { stepContextPilot } from "@agent/lib/step-context/pilot";
import { readWorkspaceTimeZone } from "@db/services/user-profile";

export function localTimeInstructions(
  now: Date,
  timeZone: string,
  canSaveTimeZone = true
) {
  const clock = localClock(now, timeZone);
  if (!canSaveTimeZone) return clock;
  return [clock, saveTimeZoneInstruction].join("\n");
}

export default defineDynamic({
  events: {
    async "turn.started"(_event, context) {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      const canSaveTimeZone = resolveModeValue(context, clockModes);
      if (
        caller?.principalType !== "user" ||
        !z.string().safeParse(caller.attributes.workspaceId).success ||
        canSaveTimeZone === null
      ) {
        return null;
      }
      const scope = scopeFromPrincipal(caller);
      // The clock changes every turn, so every instruction after it was read
      // at full price. In the pilot it goes into the step's note after the
      // history (`agent/agent.ts`), and this line explains that note.
      if (await stepContextPilot(scope)) {
        return defineInstructions({
          content: canSaveTimeZone
            ? [stepNoteInstructions, saveTimeZoneInstruction].join("\n")
            : stepNoteInstructions,
        });
      }
      return defineInstructions({
        content: localTimeInstructions(
          new Date(),
          await readWorkspaceTimeZone(scope),
          canSaveTimeZone
        ),
      });
    },
  },
});

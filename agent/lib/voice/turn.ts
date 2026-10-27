import type { ModelMessage } from "ai";
import { personMessages } from "@agent/lib/browser-use/said";
import { pilotVerdictOfTurn } from "@agent/lib/workspace-list";
import { voiceTalkMarker } from "@shared/voice/marker";
import { voiceFastEnabled } from "@shared/voice/pilot";

/**
 * Whether a person's turn answers /talk's voice in VOICE_FAST_WORKSPACES: the
 * person's latest message came from the voice page (`voiceTalkMarker`). Such
 * a turn sends no heads-up — the voice already says what it looks at (the
 * page's progress line), and the heads-up step cost 3 s before the work began
 * (prod 27.10, «Секунду, смотрю прогноз на завтра.» read aloud on top of the
 * voice's own) — and keeps every tool
 * group from its first step without asking the router, so its tool block,
 * which comes before the history, never changes between a voice
 * conversation's turns (27.10: each new topic read the prompt cold, 3–3.8 s a
 * step). Asked with the step's `turn`, the verdict of its first step holds
 * for the whole turn: a typed message mid-turn does not bring the heads-up
 * back, which the voice would read aloud.
 */
export async function fastVoiceTurn(
  messages: readonly ModelMessage[],
  workspaceId: string,
  turn?: Parameters<typeof pilotVerdictOfTurn>[1]
) {
  if (!voiceFastEnabled(workspaceId)) return false;
  return pilotVerdictOfTurn("voice-fast", turn, async () =>
    Promise.resolve(
      personMessages(messages).at(-1)?.startsWith(voiceTalkMarker) === true
    )
  );
}

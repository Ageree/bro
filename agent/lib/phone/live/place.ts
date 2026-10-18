import { updatePhoneCall } from "@db/services/phone";
import { env } from "@shared/environment";
import { readSipCredentials } from "@shared/phone/exolve";
import {
  liveCallMaxSeconds,
  liveCallRules,
  liveVoice,
  outboundPrompt,
  phoneSilenceSeconds,
} from "@shared/phone/persona";
import {
  dialLive,
  LiveCallUnavailableError,
  type LiveCallOutcome,
} from "./call";

// GPT-Live's price for a session minute (October 2026); its usage reports billed seconds.
const usdPerMinute = 0.05;
const ringSeconds = 60;

/** GPT-Live session ids; ElevenLabs conversation ids start with `conv_`. */
export const liveConversationPrefix = "live_";

export function liveCallsFor(workspaceId: string) {
  const list = env.PHONE_LIVE_WORKSPACES ?? [];
  return (
    Boolean(env.OPENAI_API_KEY) &&
    (list.includes("*") || list.includes(workspaceId))
  );
}

/** A live call still open past this was lost with the process that carried it. */
export const liveCallLostAfterMs =
  (ringSeconds + liveCallMaxSeconds + 300) * 1000;

/**
 * Dials `target` in GPT-Live from the workspace's own SIP line. Throws `LiveCallUnavailableError` when nothing
 * was dialled (the line's credentials, the carrier or GPT-Live were not ready). `dial()` places it: the call goes
 * on in this process and writes its result into the call row, which the reconciler leaves alone.
 */
export async function placeLiveCall(input: {
  callId: string;
  sipId: string;
  publicNumber: string;
  target: string;
  task: string;
  familiar: boolean | undefined;
  repeatCall: boolean;
}) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new LiveCallUnavailableError("No GPT-Live key.");
  const line = await readSipCredentials(input.sipId).catch(() => null);
  if (line?.publicNumber !== input.publicNumber)
    throw new LiveCallUnavailableError(
      "The SIP line is unavailable or carries another number."
    );
  const call = await dialLive({
    line,
    target: input.target,
    instructions: outboundPrompt({
      callRules: liveCallRules(input.familiar, new Date(), input.publicNumber),
      publicNumber: input.publicNumber,
      durationSeconds: liveCallMaxSeconds,
      repeatCall: input.repeatCall,
      task: input.task,
    }),
    voice: liveVoice,
    maxTalkSeconds: liveCallMaxSeconds,
    silenceSeconds: phoneSilenceSeconds,
    ringSeconds,
    apiKey,
    proxyUrl: env.OPENAI_PROXY_URL,
  });
  return {
    // The reconciler tells live calls by this prefix; GPT-Live's own ids carry it, but nothing promises so.
    sessionId: call.sessionId.startsWith(liveConversationPrefix)
      ? call.sessionId
      : `${liveConversationPrefix}${call.sessionId}`,
    /** Dials in the background; the call row gets its result when the call is over. */
    dial() {
      void call
        .dial()
        .then((outcome) =>
          updatePhoneCall(input.callId, liveCallResult(outcome))
        )
        .catch(() => {
          // The reconciler marks the call uncertain once `liveCallLostAfterMs` passes.
          console.warn("[phone-live] the call's result was not saved");
        });
    },
    cancel: call.cancel,
  };
}

const notConnected: [number[], string, string][] = [
  [[486, 600], "busy", "the line was busy"],
  [[603], "declined", "the person declined the call"],
  [[408, 480, 487], "no_answer", "nobody picked up"],
  [[404, 484, 604], "invalid_number", "the carrier does not know this number"],
];

/** The call row's result: what the report turn tells the person. */
export function liveCallResult(outcome: LiveCallOutcome) {
  const completedAt = new Date();
  const costUsd =
    outcome.usageSeconds === null
      ? null
      : ((outcome.usageSeconds / 60) * usdPerMinute).toFixed(4);
  if (!outcome.answered) {
    const [, reason, said] = notConnected.find(([codes]) =>
      codes.includes(outcome.sipStatus ?? 0)
    ) ?? [[], "not_connected", "the call did not connect"];
    return {
      state: "failed" as const,
      outcome: reason,
      taskSucceeded: false,
      durationSeconds: 0,
      costUsd,
      summary: `The call did not connect: ${said}${outcome.sipStatus ? ` (SIP ${String(outcome.sipStatus)})` : ""}. Nothing was said; no automatic redial was made.`,
      completedAt,
    };
  }
  const transcript = outcome.transcript.trim();
  // The report reads the whole conversation; a long one keeps its start and its end, where the result is.
  const kept =
    transcript.length <= 5800
      ? transcript
      : `${transcript.slice(0, 1800)}\n…\n${transcript.slice(-3900)}`;
  return {
    state: "done" as const,
    outcome: outcome.ending,
    taskSucceeded: null,
    durationSeconds: Math.ceil(outcome.talkSeconds),
    costUsd,
    summary: transcript
      ? `Call transcript (task success is for you to judge from it):\n${kept}`
      : "The call connected, but nothing was heard or said. Task success is not established.",
    completedAt,
  };
}

import { defineChannel, GET, POST } from "eve/channels";
import { fetch, ProxyAgent } from "undici";
import * as z from "zod";
import { voiceBrief, voiceCalendar } from "@agent/lib/voice/brief";
import {
  fastTalkInstructions,
  talkInstructions,
  voiceAcknowledgementDelayMs,
} from "@agent/lib/voice/instructions";
import { quickVoiceAnswer } from "@agent/lib/voice/quick";
import { warmVoicePrompt } from "@agent/lib/model/routerai/warm";
import { getAuthSession } from "@db/services/auth/session";
import { getFormOfAddress } from "@db/services/settings";
import { readUserProfile } from "@db/services/user-profile";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { liveVoice } from "@shared/phone/persona";
import { resolveTimeZone } from "@shared/user-profile/schema";
import {
  voiceFastEnabled,
  voiceQuickEnabled,
  voiceTalkEnabled,
} from "@shared/voice/pilot";
import {
  voiceCalendarPath,
  voicePaceHeader,
  voiceQuickHeader,
  voiceQuickPath,
  voiceSessionPath,
} from "@shared/voice/routes";

// OpenAI does not serve the VM's Russian address: the session is opened
// through the same proxy as the phone's GPT-Live, while the audio itself goes
// between the person's browser and OpenAI over WebRTC.
const proxy = env.OPENAI_PROXY_URL
  ? new ProxyAgent(env.OPENAI_PROXY_URL)
  : undefined;

const maximumOfferLength = 64 * 1024;
/**
 * How long the session waits for the person's brief: Bro's own records, a
 * few reads of the database. Past it the voice starts without one rather
 * than keep the person waiting for the line.
 */
const briefWaitMs = 1500;
/** Each of the two tries at opening the session: it answers in 0.6–1.5 s. */
const sessionTimeoutMs = 8000;

/** The person's words as the page hands them over: a few utterances. */
const quickRequestSchema = z.object({ words: z.string().min(1).max(2000) });

const answerSchema = z.object({
  session: z.object({ id: z.string() }),
  transport: z.object({ sdp: z.string().min(1) }),
});

const noStore = { "cache-control": "no-store" } as const;

/** The signed-in person behind a request of the page, or undefined. */
async function personOf(request: Request) {
  const session = await getAuthSession(request.headers);
  return session
    ? accessScopeForUser(`better-auth:${session.user.id}`)
    : undefined;
}

function within<T>(promise: Promise<T>, ms: number, fallback: T) {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => {
        resolve(fallback);
      }, ms);
    }),
  ]);
}

/**
 * /talk's doors in the agent (`app/(talk)/talk`), which alone reads Google:
 * the session the page opens with its SDP offer, the person's calendar the
 * page hands the voice once the line is up, and the quick answer it asks
 * before Bro. Outside the voice pilot none exists; the calendar only for
 * VOICE_FAST_WORKSPACES, the quick answer for VOICE_QUICK_WORKSPACES. The
 * OpenAI key stays on the server.
 */
export default defineChannel({
  audience() {
    return "unknown";
  },
  receive() {
    throw new Error("The voice channel only serves its routes.");
  },
  routes: [
    POST(voiceSessionPath, async (request) => {
      // A write comes from the page itself.
      if (request.headers.get("origin") !== applicationOrigin())
        return new Response("Not found", { status: 404 });
      const scope = await personOf(request);
      if (scope === undefined)
        return new Response("Unauthorized", { status: 401 });
      const apiKey = env.OPENAI_API_KEY;
      if (!voiceTalkEnabled(scope.workspaceId) || apiKey === undefined)
        return new Response("Not found", { status: 404 });

      const offer = await request.text();
      if (offer.length === 0 || offer.length > maximumOfferLength)
        return new Response("Bad offer", { status: 400 });

      const fast = voiceFastEnabled(scope.workspaceId);
      const now = new Date();
      const [form, profile] = await Promise.all([
        getFormOfAddress(scope),
        readUserProfile(scope),
      ]);
      const timeZone = resolveTimeZone(profile.timezone);
      const person = {
        name: form.name ?? profile.firstName ?? undefined,
        formal: form.formal,
        timeZone,
        now,
      };
      const briefFrom = performance.now();
      const instructions = fast
        ? fastTalkInstructions({
            ...person,
            brief: await within(
              voiceBrief(scope, { now, timeZone }),
              briefWaitMs,
              ""
            ),
          })
        : talkInstructions(person);
      const startedAt = performance.now();
      const briefMs = Math.round(startedAt - briefFrom);
      const body = JSON.stringify({
        session: {
          model: "gpt-live-1",
          instructions,
          audio: { output: { voice: liveVoice } },
          delegation: fast
            ? {
                type: "client",
                acknowledgement_delay_ms: voiceAcknowledgementDelayMs,
              }
            : { type: "client" },
        },
        transport: { type: "webrtc", sdp: offer },
      });
      const open = async () =>
        await fetch("https://api.openai.com/v1/live/sessions", {
          method: "POST",
          dispatcher: proxy,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(sessionTimeoutMs),
        });
      /** An answer below 500, or undefined after OpenAI's own error or none. */
      const tryOpen = async (attempt: number) => {
        try {
          const answered = await open();
          if (answered.status < 500) return answered;
          console.warn("[voice] GPT-Live refused the session", {
            attempt,
            status: answered.status,
            body: (await answered.text()).slice(0, 300),
          });
        } catch (error) {
          console.warn("[voice] GPT-Live did not answer", {
            attempt,
            reason: error instanceof Error ? error.message : "unknown",
            ms: Math.round(performance.now() - startedAt),
          });
        }
        return undefined;
      };
      // OpenAI's own 500 (prod 27.10, 1 session in 4) or no answer: asked
      // once more, the same offer, before the page says it could not connect.
      const answer = (await tryOpen(1)) ?? (await tryOpen(2));
      if (answer === undefined)
        return new Response("Voice unavailable", { status: 502 });
      if (!answer.ok) {
        console.warn("[voice] GPT-Live refused the session", {
          status: answer.status,
          body: (await answer.text()).slice(0, 300),
        });
        return new Response("Voice unavailable", { status: 502 });
      }
      const parsed = answerSchema.safeParse(
        await answer.json().catch(() => undefined)
      );
      if (!parsed.success) {
        console.warn("[voice] GPT-Live answered without SDP");
        return new Response("Voice unavailable", { status: 502 });
      }
      // The first question reads its prompt from the cache.
      if (fast) warmVoicePrompt(scope.workspaceId);
      console.info("[voice] session", {
        fast,
        instructionsChars: instructions.length,
        session: parsed.data.session.id,
        // The wait for the person's brief before it, then OpenAI's answer.
        briefMs,
        ms: Math.round(performance.now() - startedAt),
      });
      return new Response(parsed.data.transport.sdp, {
        headers: {
          ...noStore,
          "Content-Type": "application/sdp",
          // The page paces the fast voice's wait itself.
          ...(fast && { [voicePaceHeader]: "page" }),
          ...(voiceQuickEnabled(scope.workspaceId) && {
            [voiceQuickHeader]: "on",
          }),
        },
      });
    }),
    // A question the web answers, before the page hands the words to Bro:
    // `answer` null sends them on to Bro (`agent/lib/voice/quick.ts`).
    POST(voiceQuickPath, async (request) => {
      if (request.headers.get("origin") !== applicationOrigin())
        return new Response("Not found", { status: 404 });
      const scope = await personOf(request);
      if (scope === undefined)
        return new Response("Unauthorized", { status: 401 });
      if (!voiceQuickEnabled(scope.workspaceId))
        return new Response("Not found", { status: 404 });
      const asked = quickRequestSchema.safeParse(
        await request.json().catch(() => undefined)
      );
      if (!asked.success) return new Response("Bad words", { status: 400 });
      const profile = await readUserProfile(scope);
      const answer = await quickVoiceAnswer(scope, asked.data.words, {
        now: new Date(),
        timeZone: resolveTimeZone(profile.timezone),
        city: profile.city ?? undefined,
      });
      return Response.json({ answer: answer ?? null }, { headers: noStore });
    }),
    // The next week of the person's calendar, as lines the page appends to
    // the voice's context: Google through Composio takes a second or two,
    // which the session's start does not wait for.
    GET(voiceCalendarPath, async (request) => {
      const scope = await personOf(request);
      if (scope === undefined)
        return new Response("Unauthorized", { status: 401 });
      if (!voiceFastEnabled(scope.workspaceId))
        return new Response("Not found", { status: 404 });
      const profile = await readUserProfile(scope);
      const startedAt = performance.now();
      const calendar = await voiceCalendar(scope, {
        now: new Date(),
        timeZone: resolveTimeZone(profile.timezone),
      });
      console.info("[voice] calendar", {
        read: calendar !== undefined,
        ms: Math.round(performance.now() - startedAt),
      });
      return calendar === undefined
        ? new Response(null, { headers: noStore, status: 204 })
        : new Response(calendar, {
            headers: {
              ...noStore,
              "Content-Type": "text/plain; charset=utf-8",
            },
          });
    }),
  ],
});

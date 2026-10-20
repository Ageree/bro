import { fetch, ProxyAgent } from "undici";
import * as z from "zod";
import { getFormOfAddress } from "@db/services/settings";
import { readUserProfile } from "@db/services/user-profile";
import { env } from "@shared/environment";
import { liveVoice } from "@shared/phone/persona";
import { resolveTimeZone } from "@shared/user-profile/schema";
import { voiceTalkEnabled } from "@shared/voice/pilot";
import {
  requireRequestScope,
  UnauthenticatedError,
} from "@web/auth/request-scope";
import { talkInstructions } from "./instructions";

export const runtime = "nodejs";

// OpenAI does not serve the VM's Russian address: the session is opened
// through the same proxy as the phone's GPT-Live, while the audio itself goes
// between the person's browser and OpenAI over WebRTC.
const proxy = env.OPENAI_PROXY_URL
  ? new ProxyAgent(env.OPENAI_PROXY_URL)
  : undefined;

const maximumOfferLength = 64 * 1024;

const answerSchema = z.object({
  session: z.object({ id: z.string() }),
  transport: z.object({ sdp: z.string().min(1) }),
});

/**
 * Opens a GPT-Live session for /talk: the page posts its SDP offer, and the
 * answer comes back as `application/sdp`. The key stays on the server.
 */
export async function POST(request: Request) {
  let scope;
  try {
    scope = await requireRequestScope();
  } catch (error) {
    if (error instanceof UnauthenticatedError)
      return new Response("Unauthorized", { status: 401 });
    throw error;
  }
  const apiKey = env.OPENAI_API_KEY;
  if (!voiceTalkEnabled(scope.workspaceId) || apiKey === undefined)
    return new Response("Not found", { status: 404 });

  const offer = await request.text();
  if (offer.length === 0 || offer.length > maximumOfferLength)
    return new Response("Bad offer", { status: 400 });

  const [form, profile] = await Promise.all([
    getFormOfAddress(scope),
    readUserProfile(scope),
  ]);
  const startedAt = performance.now();
  let answer: Awaited<ReturnType<typeof fetch>>;
  try {
    answer = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      dispatcher: proxy,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          model: "gpt-live-1",
          instructions: talkInstructions({
            name: form.name ?? profile.firstName ?? undefined,
            formal: form.formal,
            timeZone: resolveTimeZone(profile.timezone),
            now: new Date(),
          }),
          audio: { output: { voice: liveVoice } },
          delegation: { type: "client" },
        },
        transport: { type: "webrtc", sdp: offer },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.warn("[voice] GPT-Live did not answer", {
      reason: error instanceof Error ? error.message : "unknown",
      ms: Math.round(performance.now() - startedAt),
    });
    return new Response("Voice unavailable", { status: 502 });
  }
  if (!answer.ok) {
    console.warn("[voice] GPT-Live refused the session", {
      status: answer.status,
      body: (await answer.text()).slice(0, 300),
    });
    return new Response("Voice unavailable", { status: 502 });
  }
  const parsed = answerSchema.safeParse(await answer.json());
  if (!parsed.success) {
    console.warn("[voice] GPT-Live answered without SDP");
    return new Response("Voice unavailable", { status: 502 });
  }
  console.info("[voice] session", {
    session: parsed.data.session.id,
    ms: Math.round(performance.now() - startedAt),
  });
  return new Response(parsed.data.transport.sdp, {
    headers: {
      "Content-Type": "application/sdp",
      "Cache-Control": "no-store",
    },
  });
}

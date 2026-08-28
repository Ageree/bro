import {
  attachCallToJob,
  callTranscript,
  formatCallWake,
  parseCallEnded,
} from "../../convex/lib/callPolicy.ts";
import {
  finishCallLegByInkbox,
  getTenant,
  listOpenJobs,
} from "./convex";
import { agentHandle, isAccessHandle, webhookOk } from "./inkbox";

function handleFromRequest(request: Request): string | undefined {
  try {
    const h = new URL(request.url).searchParams.get("h");
    if (h && isAccessHandle(h)) return h;
  } catch {
    return undefined;
  }
  return undefined;
}

export type CallIngest =
  | {
      conversationId: string;
      phone: string;
      handle: string;
      text: string;
    }
  | { drop: string; status?: number };

export async function ingestEndedCall(request: Request): Promise<CallIngest> {
  const secret = process.env.INKBOX_WEBHOOK_SECRET;
  if (!secret) return { drop: "missing secret", status: 500 };

  const payload = Buffer.from(await request.arrayBuffer());
  if (!webhookOk(payload, request.headers, secret)) {
    return { drop: "unauthorized", status: 401 };
  }

  let body: unknown;
  try {
    body = JSON.parse(payload.toString());
  } catch {
    return { drop: "bad json", status: 400 };
  }

  const ended = parseCallEnded(body);
  if (!ended) return { drop: "ignored event" };

  const leg = await finishCallLegByInkbox(ended.callId).catch((err) => {
    console.error("finish call leg failed", err);
    return null;
  });
  if (!leg) return { drop: "unknown call" };

  const tenant = await getTenant(leg.tenantPhone).catch((err) => {
    console.error("getTenant failed", err);
    return null;
  });
  if (!tenant || tenant.status === "disabled") return { drop: "disabled" };
  const conversationId = tenant.inkboxConversationId;
  const phone = tenant.phoneE164 ?? leg.tenantPhone;
  if (!conversationId || !phone) return { drop: "unbound tenant" };

  const jobs = await listOpenJobs(phone).catch((err) => {
    console.error("listOpenJobs failed", err);
    return [];
  });
  const jobId =
    leg.jobId ??
    attachCallToJob(
      jobs.map((j) => ({
        id: j._id,
        status: j.status,
        waitingFor: j.waitingFor,
        callExternalId: j.callExternalId,
      })),
      ended.callId,
    );

  return {
    conversationId,
    phone,
    handle: tenant.inkboxHandle ?? handleFromRequest(request) ?? agentHandle(),
    text: formatCallWake({
      jobId,
      callId: ended.callId,
      destE164: leg.destE164,
      route: leg.route,
      status: ended.status,
      durationSec: ended.durationSec,
      outcome: ended.outcome,
      transcript: callTranscript(body),
    }),
  };
}

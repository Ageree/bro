const E164_RE = /^\+[1-9]\d{7,14}$/;

export type CallRoute = "inkbox_direct" | "ru_bridge" | "vox_callback" | "blocked";

export type CallEnv = {
  inkboxRuEnabled: boolean;
  ruBridgeE164: string | null;
  inkboxFromE164: string | null;
  voxFromE164: string | null;
};

export function normalizeE164(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) {
    return normalizeE164(`+${digits.slice(2)}`);
  }
  if (digits.startsWith("8") && digits.length === 11) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.startsWith("+")) return E164_RE.test(digits) ? digits : null;
  if (digits.length === 11 && digits.startsWith("7")) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
  return E164_RE.test(`+${digits}`) ? `+${digits}` : null;
}

export function isRuE164(e164: string): boolean {
  return e164.startsWith("+7") && e164.length >= 11 && e164.length <= 12;
}

/** Inkbox Chime PSTN: live probes dial +1 (US/CA) and fail +7 / +44. */
export function isInkboxDialableE164(e164: string): boolean {
  return e164.startsWith("+1") && e164.length === 12;
}

export function parseCallEnv(env: NodeJS.ProcessEnv): CallEnv {
  const bridge = normalizeE164(env.BRO_RU_BRIDGE_E164 ?? "");
  const from = normalizeE164(env.INKBOX_PHONE_NUMBER ?? "");
  const voxFrom = normalizeE164(env.VOXIMPLANT_FROM_E164 ?? "");
  const flag = (env.BRO_INKBOX_RU_ENABLED ?? "").trim().toLowerCase();
  return {
    inkboxRuEnabled: flag === "1" || flag === "true" || flag === "yes",
    ruBridgeE164: bridge,
    inkboxFromE164: from,
    voxFromE164: voxFrom,
  };
}

export function decideCallRoute(
  destRaw: string,
  env: CallEnv,
):
  | { route: "inkbox_direct"; destE164: string; dialE164: string }
  | { route: "ru_bridge"; destE164: string; dialE164: string }
  | { route: "vox_callback"; destE164: string; dialE164: string }
  | { route: "blocked"; destE164?: string; error: string } {
  const dest = normalizeE164(destRaw);
  if (!dest) return { route: "blocked", error: "bad dest number" };
  if (!env.inkboxFromE164) {
    return { route: "blocked", destE164: dest, error: "no Inkbox phone number" };
  }
  if (
    dest === env.inkboxFromE164 ||
    dest === env.ruBridgeE164 ||
    dest === env.voxFromE164
  ) {
    return { route: "blocked", destE164: dest, error: "cannot call self" };
  }
  if (isRuE164(dest) && !env.inkboxRuEnabled) {
    if (env.ruBridgeE164 && isInkboxDialableE164(env.ruBridgeE164)) {
      return { route: "ru_bridge", destE164: dest, dialE164: env.ruBridgeE164 };
    }
    if (env.voxFromE164) {
      return {
        route: "vox_callback",
        destE164: dest,
        dialE164: env.inkboxFromE164,
      };
    }
    return {
      route: "blocked",
      destE164: dest,
      error:
        "RU dest needs VOXIMPLANT_FROM_E164 (verified mobile) or a +1 BRO_RU_BRIDGE_E164",
    };
  }
  return { route: "inkbox_direct", destE164: dest, dialE164: dest };
}

export function inkboxPlaceBody(opts: {
  fromE164: string;
  dialE164: string;
  reason: string;
}): Record<string, string> {
  return {
    origination: "dedicated_number",
    from_number: opts.fromE164,
    to_number: opts.dialE164,
    mode: "hosted_agent",
    reason: opts.reason.trim().slice(0, 2000),
    voicemail_detection: "disabled",
  };
}

export type CallJobSnap = {
  id: string;
  status: string;
  waitingFor?: string;
  callExternalId?: string;
};

export function attachCallToJob(
  jobs: CallJobSnap[],
  inkboxCallId: string | null,
): string | null {
  const waiting = jobs.filter(
    (j) => j.status === "waiting" && j.waitingFor === "call",
  );
  if (inkboxCallId) {
    const hit = waiting.find((j) => j.callExternalId === inkboxCallId);
    if (hit) return hit.id;
  }
  if (waiting.length === 1) return waiting[0]!.id;
  return null;
}

export function formatCallWake(opts: {
  jobId: string | null;
  callId: string;
  destE164: string;
  route: string;
  status: string;
  durationSec?: number | null;
  outcome?: string | null;
  transcript?: string | null;
}): string {
  const transcript = (opts.transcript ?? "").trim();
  const body =
    transcript.length > 2000 ? `${transcript.slice(0, 2000)}…` : transcript;
  return [
    "[event:call]",
    `job: ${opts.jobId ?? "none"}`,
    `id: ${opts.callId}`,
    `dest: ${opts.destE164}`,
    `route: ${opts.route}`,
    `status: ${opts.status}`,
    `duration: ${opts.durationSec ?? 0}`,
    `outcome: ${opts.outcome ?? ""}`,
    "transcript:",
    body,
  ].join("\n");
}

export function callWebhookUrl(imessageBase: string, handle?: string): string {
  const u = new URL(imessageBase);
  u.pathname = u.pathname.replace(/\/webhooks\/imessage\/?$/, "/webhooks/call");
  if (!u.pathname.endsWith("/webhooks/call")) u.pathname = "/webhooks/call";
  if (handle) u.searchParams.set("h", handle);
  return u.toString();
}

export const CALL_LEG_STALE_MS = 15 * 60_000;

export function pickClaimableLeg(
  rows: { id: string; createdAt: number }[],
  now: number,
  staleMs = CALL_LEG_STALE_MS,
): { claimId: string | null; staleIds: string[] } {
  const staleIds: string[] = [];
  let claimId: string | null = null;
  for (const row of [...rows].sort((a, b) => a.createdAt - b.createdAt)) {
    if (now - row.createdAt > staleMs) {
      staleIds.push(row.id);
      continue;
    }
    if (!claimId) claimId = row.id;
  }
  return { claimId, staleIds };
}

export function hostedReason(opts: {
  destE164: string;
  task: string;
  callerName?: string;
}): string {
  const name = (opts.callerName ?? "").trim();
  const who = name
    ? `Клиента зовут ${name}.`
    : "Звонишь по поручению клиента.";
  return [
    "Ты Bro, живой помощник. Говори по-русски, коротко, без канцелярита.",
    "Не говори что ты ИИ и не упоминай Inkbox.",
    who,
    `Ты звонишь на ${opts.destE164}.`,
    `Задача: ${opts.task.trim()}`,
    "Если трубку не берут или автоответчик — коротко оставь суть и повесь.",
    "Когда задача решена или отказали — вежливо попрощайся и заверши звонок.",
  ]
    .join(" ")
    .slice(0, 2000);
}

export function flattenTranscript(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return "";
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as {
      party?: unknown;
      text?: unknown;
      marker?: unknown;
    };
    if (rec.marker === "abridged") {
      lines.push("…");
      continue;
    }
    if (typeof rec.text === "string" && rec.text.trim()) {
      const who =
        rec.party === "local"
          ? "bro"
          : rec.party === "remote"
            ? "them"
            : "??";
      lines.push(`${who}: ${rec.text.trim()}`);
    }
  }
  return lines.join("\n");
}

export type CallEndedSnap = {
  callId: string;
  destHint: string;
  status: string;
  durationSec: number | null;
  outcome: string | null;
};

export function parseCallEnded(body: unknown): CallEndedSnap | null {
  if (!body || typeof body !== "object") return null;
  const rec = body as { event_type?: unknown; data?: unknown };
  if (rec.event_type !== "call.ended") return null;
  const data =
    rec.data && typeof rec.data === "object"
      ? (rec.data as Record<string, unknown>)
      : {};
  const call =
    data.call && typeof data.call === "object"
      ? (data.call as Record<string, unknown>)
      : {};
  const callId = typeof call.id === "string" ? call.id : "";
  if (!callId) return null;
  const items = Array.isArray(data.post_call_action_items)
    ? data.post_call_action_items
        .map((item) => {
          if (!item || typeof item !== "object") return "";
          const o = item as { action?: unknown; details?: unknown };
          const action = typeof o.action === "string" ? o.action : "";
          const details = typeof o.details === "string" ? o.details : "";
          return [action, details].filter(Boolean).join(" — ");
        })
        .filter(Boolean)
        .join("\n")
    : "";
  const outcome = typeof data.outcome === "string" ? data.outcome : "";
  return {
    callId,
    destHint:
      typeof call.remote_phone_number === "string"
        ? call.remote_phone_number
        : "",
    status: typeof call.status === "string" ? call.status : "",
    durationSec:
      typeof call.duration_seconds === "number" ? call.duration_seconds : null,
    outcome: [outcome, items].filter(Boolean).join("\n") || null,
  };
}

export function callTranscript(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return "";
  return flattenTranscript((data as { transcript?: unknown }).transcript);
}

/** HMAC-SHA1 payload for Zadarma NOTIFY_* Signature header. */
export function zadarmaNotifyPayload(
  callerId: string,
  calledDid: string,
  callStart: string,
): string {
  return `${callerId}${calledDid}${callStart}`;
}

export function zadarmaForwardNumber(destE164: string): string {
  return destE164.replace(/^\+/, "");
}

export type ZadarmaBridgeReply =
  | { hangup: 1 }
  | {
      redirect: string;
      rewrite_forward_number: string;
      return_timeout: 0;
    };

/** PBX extension must already have unconditional forward enabled. */
export function zadarmaBridgeReply(
  destE164: string | null,
  pbxExtension: string,
): ZadarmaBridgeReply {
  const ext = pbxExtension.trim() || "100";
  if (!destE164) return { hangup: 1 };
  return {
    redirect: ext,
    rewrite_forward_number: zadarmaForwardNumber(destE164),
    return_timeout: 0,
  };
}

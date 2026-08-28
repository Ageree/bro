import {
  Inkbox,
  verifyWebhook,
  type IMessage,
  type IMessageReaction,
} from "@inkbox/sdk";

/** Named tapbacks `sendIMessageReaction` accepts. `custom` is inbound-only. */
export const IMESSAGE_TAPBACKS = [
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
  "eyes",
] as const;

export type IMessageTapback = (typeof IMESSAGE_TAPBACKS)[number];

export function isIMessageTapback(value: string): value is IMessageTapback {
  return (IMESSAGE_TAPBACKS as readonly string[]).includes(value);
}

/** Latest inbound id from channel auth attributes. Never take an id from the model. */
export function reactionTargetId(
  attributes: Record<string, unknown> | undefined,
): string | undefined {
  const raw = attributes?.messageId;
  const fromAuth = Array.isArray(raw) ? raw[0] : raw;
  if (typeof fromAuth === "string" && fromAuth.trim().length > 0) {
    return fromAuth.trim();
  }
  return undefined;
}

let client: Inkbox | null = null;

export function inkbox(): Inkbox {
  if (!client) client = new Inkbox();
  return client;
}

export function agentHandle(): string {
  return process.env.INKBOX_AGENT_HANDLE ?? "bro-ageree";
}

export function isAccessHandle(h: string): boolean {
  return /^bro-[a-z0-9]{8}$/.test(h);
}

export function webhookOk(
  payload: Buffer,
  headers: Headers,
  secret: string,
): boolean {
  const rec: Record<string, string> = {};
  headers.forEach((v, k) => {
    rec[k] = v;
  });
  return verifyWebhook({ payload, headers: rec, secret });
}

export function allowlisted(e164: string | null | undefined): boolean {
  const raw = process.env.ALLOWED_SENDERS?.trim();
  if (!raw) return true;
  if (!e164) return false;
  return raw.split(",").map((s) => s.trim()).includes(e164);
}

export function isBlueIMessage(msg: {
  service?: string | null;
  wasDowngraded?: boolean | null;
}): boolean {
  if (msg.wasDowngraded) return false;
  if (msg.service && msg.service !== "imessage") return false;
  return true;
}

export async function sendBlueIMessage(opts: {
  conversationId: string;
  text: string;
  handle?: string;
}): Promise<IMessage> {
  const identity = await inkbox().getIdentity(opts.handle ?? agentHandle());
  const sent = await identity.sendIMessage({
    conversationId: opts.conversationId,
    text: opts.text,
  });
  if (!isBlueIMessage(sent)) {
    throw new Error(
      `refusing SMS/RCS fallback (service=${sent.service} downgraded=${sent.wasDowngraded})`,
    );
  }
  return sent;
}

const INKBOX_API = "https://inkbox.ai/api/v1";

function readCallId(json: Record<string, unknown>): string {
  if (typeof json.id === "string" && json.id) return json.id;
  const call = json.call;
  if (call && typeof call === "object") {
    const id = (call as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return "";
}

/** REST place-call. Do not guess SDK method names. */
export async function placeCall(
  body: Record<string, string>,
): Promise<{ id: string; raw: Record<string, unknown> }> {
  const key = process.env.INKBOX_API_KEY;
  if (!key) throw new Error("INKBOX_API_KEY missing");
  const res = await fetch(`${INKBOX_API}/phone/place-call`, {
    method: "POST",
    headers: {
      "X-API-Key": key,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const detail = json.detail ?? json.error ?? json.raw ?? text.slice(0, 400);
    throw new Error(
      `inkbox place-call ${res.status}: ${
        typeof detail === "string" ? detail : JSON.stringify(detail)
      }`,
    );
  }
  const id = readCallId(json);
  if (!id) throw new Error("inkbox place-call missing id");
  return { id, raw: json };
}

const BRO_IDENTITY = "d051f194-1bd9-405b-b6fe-2b3544caec58";

/** Inbound Voice AI has no per-call reason; write the brief onto the identity. */
export async function setHostedAgentInstructions(
  instructions: string,
): Promise<void> {
  const key = process.env.INKBOX_API_KEY;
  if (!key) throw new Error("INKBOX_API_KEY missing");
  const id = process.env.INKBOX_IDENTITY_ID ?? BRO_IDENTITY;
  const headers = {
    "X-API-Key": key,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const got = await fetch(
    `${INKBOX_API}/phone/hosted-agent-config?agent_identity_id=${id}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  const prev = got.ok
    ? ((await got.json()) as Record<string, unknown>)
    : {};
  const res = await fetch(
    `${INKBOX_API}/phone/hosted-agent-config?agent_identity_id=${id}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        voice: prev.voice ?? null,
        model: prev.model ?? null,
        instructions: instructions.trim().slice(0, 2000),
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`inkbox hosted-agent-config ${res.status}: ${text.slice(0, 300)}`);
  }
}

export async function sendIMessageTapback(opts: {
  messageId: string;
  reaction: IMessageTapback;
  handle?: string;
}): Promise<IMessageReaction> {
  const identity = await inkbox().getIdentity(opts.handle ?? agentHandle());
  return identity.sendIMessageReaction({
    messageId: opts.messageId,
    reaction: opts.reaction,
  });
}

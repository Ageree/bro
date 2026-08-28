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

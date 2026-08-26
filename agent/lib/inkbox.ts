import { Inkbox, verifyWebhook, type IMessage } from "@inkbox/sdk";

let client: Inkbox | null = null;

export function inkbox(): Inkbox {
  if (!client) client = new Inkbox();
  return client;
}

export function agentHandle(): string {
  return process.env.INKBOX_AGENT_HANDLE ?? "bro";
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
}): Promise<IMessage> {
  const identity = await inkbox().getIdentity(agentHandle());
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

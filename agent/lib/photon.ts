import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isBluePhotonService,
  parsePhotonInboundJson,
} from "../../convex/lib/photonPolicy.ts";

export type PhotonSendResult = {
  spaceId: string;
  service?: string;
};

function projectCreds(): { id: string; secret: string } {
  const id = process.env.SPECTRUM_PROJECT_ID?.trim();
  const secret = process.env.SPECTRUM_PROJECT_SECRET?.trim();
  if (!id || !secret) throw new Error("SPECTRUM_PROJECT_ID/SECRET missing");
  return { id, secret };
}

export function photonWebhookSecret(): string | undefined {
  const s = process.env.SPECTRUM_WEBHOOK_SECRET?.trim();
  return s || undefined;
}

/** Native Spectrum HMAC: v0:{timestamp}:{body}, header `v0=<hex>`. */
export function photonWebhookOk(
  payload: Buffer,
  headers: Headers,
  secret: string,
): boolean {
  const ts = headers.get("x-spectrum-timestamp") ?? headers.get("X-Spectrum-Timestamp");
  const sig = headers.get("x-spectrum-signature") ?? headers.get("X-Spectrum-Signature");
  if (!ts || !sig) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return false;
  const hex = sig.startsWith("v0=") ? sig.slice(3) : sig;
  const expected = createHmac("sha256", secret)
    .update(`v0:${ts}:${payload.toString("utf8")}`)
    .digest("hex");
  try {
    const a = Buffer.from(hex, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function readPhotonInbound(body: unknown): {
  spaceId: string;
  messageId?: string;
  text: string;
  senderPhone: string;
  service?: string;
  userId?: string;
  assignedPhoneNumber?: string;
  isEcho: boolean;
} | undefined {
  const parsed = parsePhotonInboundJson(body);
  if (!parsed?.spaceId || !parsed.senderPhone) return undefined;
  return {
    spaceId: parsed.spaceId,
    messageId: parsed.messageId,
    text: (parsed.text ?? "").trim(),
    senderPhone: parsed.senderPhone,
    service: parsed.service,
    userId: parsed.userId,
    assignedPhoneNumber: parsed.assignedPhoneNumber,
    isEcho: parsed.isEcho === true,
  };
}

type SpectrumApp = {
  stop?: () => Promise<void>;
};

type SpectrumIm = {
  user: (phone: string) => Promise<unknown>;
  space: {
    get: (id: string) => Promise<{ send: (content: unknown) => Promise<unknown> }>;
    create: (user: unknown) => Promise<{
      id?: string;
      send: (content: unknown) => Promise<unknown>;
    }>;
  };
};

async function withSpectrum<T>(fn: (im: SpectrumIm, app: SpectrumApp) => Promise<T>): Promise<T> {
  const { id, secret } = projectCreds();
  const [{ Spectrum }, { imessage }] = await Promise.all([
    import("spectrum-ts"),
    import("spectrum-ts/providers/imessage"),
  ]);
  const app = await Spectrum({
    projectId: id,
    projectSecret: secret,
    providers: [imessage.config()],
  }) as SpectrumApp;
  try {
    return await fn(imessage(app) as SpectrumIm, app);
  } finally {
    await app.stop?.().catch(() => undefined);
  }
}

function sentService(sent: unknown): string | undefined {
  if (!sent || typeof sent !== "object") return undefined;
  const rec = sent as Record<string, unknown>;
  const content = rec.content && typeof rec.content === "object"
    ? (rec.content as Record<string, unknown>)
    : undefined;
  const sender = rec.sender && typeof rec.sender === "object"
    ? (rec.sender as Record<string, unknown>)
    : undefined;
  const service =
    (typeof rec.service === "string" && rec.service) ||
    (typeof content?.service === "string" && content.service) ||
    (typeof sender?.service === "string" && sender.service) ||
    undefined;
  return service;
}

export async function sendPhotonText(opts: {
  conversationId?: string;
  to?: string;
  text: string;
}): Promise<PhotonSendResult> {
  const text = opts.text.trim();
  if (!text) throw new Error("empty photon text");
  return await withSpectrum(async (im) => {
    const space = opts.conversationId
      ? await im.space.get(opts.conversationId)
      : await im.space.create(await im.user(opts.to ?? ""));
    const sent = await space.send(text);
    const service = sentService(sent);
    if (!isBluePhotonService({ service })) {
      throw new Error(`refusing SMS/RCS fallback (service=${service ?? "unknown"})`);
    }
    const spaceId =
      (space as { id?: string }).id ??
      opts.conversationId ??
      "";
    if (!spaceId) throw new Error("photon send missing space id");
    return { spaceId, service };
  });
}

export async function sendPhotonMedia(opts: {
  conversationId: string;
  url: string;
  text?: string;
}): Promise<PhotonSendResult> {
  return await withSpectrum(async (im) => {
    const space = await im.space.get(opts.conversationId);
    const caption = opts.text?.trim();
    const sent = await space.send(
      caption
        ? { type: "text", text: caption, attachments: [{ url: opts.url }] }
        : { type: "file", url: opts.url },
    );
    const service = sentService(sent);
    if (!isBluePhotonService({ service })) {
      throw new Error(`refusing SMS/RCS fallback (service=${service ?? "unknown"})`);
    }
    return { spaceId: opts.conversationId, service };
  });
}

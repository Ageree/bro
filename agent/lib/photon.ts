import { createHmac, timingSafeEqual } from "node:crypto";
// spectrum-ts iMessage still boots createGrpcClient. Those packages are
// optional peers of @photon-ai/advanced-imessage, so eve's Vercel bundle
// drops them unless this module names them. Without them every inbound
// (first «привет» and later turns, new signup or existing tenant) binds
// then every outbound send throws MODULE_NOT_FOUND.
import "@grpc/grpc-js";
import "nice-grpc";
import "nice-grpc-common";
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

/**
 * The exact inverse of `photonWebhookOk`, for the test harness: it lets a
 * scenario drive the real `/webhooks/photon` route — signature check, bind,
 * quota gate, fast-ack lane, the actual turn — instead of a simulated copy of
 * it that would quietly stop matching the day the real path changes.
 *
 * It lives next to the verifier rather than in the runner so the two cannot
 * drift: a change to the signing string has to break one of them visibly.
 */
export function signSpectrumWebhook(
  payload: string,
  secret: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): { timestamp: string; signature: string } {
  const timestamp = String(timestampSeconds);
  const signature = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${payload}`)
    .digest("hex");
  return { timestamp, signature: `v0=${signature}` };
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

type SpectrumSpace = {
  id?: string;
  send: (content: unknown) => Promise<unknown>;
  startTyping?: () => Promise<void>;
  stopTyping?: () => Promise<void>;
};

type SpectrumIm = {
  user: (phone: string) => Promise<unknown>;
  space: {
    get: (id: string) => Promise<SpectrumSpace>;
    create: (user: unknown) => Promise<SpectrumSpace>;
  };
};

type SpectrumHandle = { im: SpectrumIm; app: SpectrumApp };

/** Booting a Spectrum app costs two Photon HTTP calls (project + iMessage
 *  tokens) plus a TLS gRPC handshake — 1–2 s. One boot per send put that in
 *  front of every bubble, including the first streamed one. Keep one app per
 *  instance; the SDK refreshes its own tokens. `photon send` invalidates on a
 *  transport error so the next call reboots. */
let spectrumHandle: Promise<SpectrumHandle> | undefined;
let spectrumCredsKey: string | undefined;

function credsKey(id: string, secret: string): string {
  return `${id}\n${secret}`;
}

async function bootSpectrum(id: string, secret: string): Promise<SpectrumHandle> {
  const [{ Spectrum }, { imessage }] = await Promise.all([
    import("spectrum-ts"),
    import("spectrum-ts/providers/imessage"),
  ]);
  const app = await Spectrum({
    projectId: id,
    projectSecret: secret,
    providers: [imessage.config()],
  });
  return { im: imessage(app) as unknown as SpectrumIm, app: app as SpectrumApp };
}

/** Whether sends reuse one Spectrum app (default) or boot one per call. */
export function photonKeepAlive(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.BRO_PHOTON_KEEPALIVE?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

function spectrumApp(): Promise<SpectrumHandle> {
  const { id, secret } = projectCreds();
  const key = credsKey(id, secret);
  if (spectrumHandle && spectrumCredsKey === key) return spectrumHandle;
  const pending = bootSpectrum(id, secret);
  spectrumHandle = pending;
  spectrumCredsKey = key;
  pending.catch(() => {
    if (spectrumHandle === pending) spectrumHandle = undefined;
  });
  return pending;
}

/** Drop the cached app (after a transport error). The old app is stopped in
 *  the background; a concurrent send that still holds it finishes on it. */
export function resetSpectrum(): void {
  const stale = spectrumHandle;
  spectrumHandle = undefined;
  spectrumCredsKey = undefined;
  if (stale) {
    void stale
      .then((h) => h.app.stop?.())
      .catch(() => undefined);
  }
}

/** Warm the Photon transport ahead of the first bubble (webhook, keep-warm). */
export function prefetchSpectrum(): void {
  if (!photonKeepAlive()) return;
  try {
    void spectrumApp().catch((err) => console.error("[photon] warm failed", err));
  } catch {
    // creds missing — nothing to warm
  }
}

function isTransportError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /UNAVAILABLE|UNAUTHENTICATED|DEADLINE|ECONNRESET|ECONNREFUSED|socket|closed|channel|token|expired|auth/i.test(
    text,
  );
}

async function withSpectrum<T>(fn: (im: SpectrumIm, app: SpectrumApp) => Promise<T>): Promise<T> {
  if (!photonKeepAlive()) {
    const { id, secret } = projectCreds();
    const { im, app } = await bootSpectrum(id, secret);
    try {
      return await fn(im, app);
    } finally {
      await app.stop?.().catch(() => undefined);
    }
  }
  const handle = spectrumApp();
  const { im, app } = await handle;
  try {
    return await fn(im, app);
  } catch (err) {
    if (spectrumHandle === handle && isTransportError(err)) resetSpectrum();
    throw err;
  }
}

/** iMessage «печатает…» bubble. Best effort: never throws, never blocks. */
export async function sendPhotonTyping(opts: {
  conversationId: string;
  state?: "start" | "stop";
}): Promise<boolean> {
  const conversationId = opts.conversationId.trim();
  if (!conversationId) return false;
  try {
    return await withSpectrum(async (im) => {
      const space = await im.space.get(conversationId);
      if (opts.state === "stop") {
        if (!space.stopTyping) return false;
        await space.stopTyping();
      } else {
        if (!space.startTyping) return false;
        await space.startTyping();
      }
      return true;
    });
  } catch (err) {
    console.error("[photon] typing failed", err);
    return false;
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

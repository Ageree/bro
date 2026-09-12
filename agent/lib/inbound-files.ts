import { filenameFromUrl, uploadFileBytes } from "./files.ts";
import { readLimited } from "./voice.ts";
import type { TelegramMessage } from "./telegram.ts";
import { largestPhoto, telegramFileUrl } from "./telegram.ts";

const INBOUND_MAX = 8 * 1024 * 1024;
const INBOUND_TIMEOUT_MS = 15_000;

export async function saveInboundRemoteFile(opts: {
  phoneE164: string;
  url: string;
  name?: string;
  mimeType?: string;
  sourceChannel: "imessage" | "telegram";
  fetch?: typeof fetch;
}): Promise<{ name: string } | null> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(opts.url, {
    signal: AbortSignal.timeout(INBOUND_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = await readLimited(res, INBOUND_MAX);
  if ("error" in body) return null;
  const mimeType =
    opts.mimeType?.trim() ||
    res.headers.get("content-type")?.split(";")[0].trim() ||
    "application/octet-stream";
  const name = opts.name?.trim() || filenameFromUrl(opts.url, "inbound.bin");
  const saved = await uploadFileBytes(opts.phoneE164, {
    name,
    mimeType,
    bytes: body,
    sourceChannel: opts.sourceChannel,
  });
  return { name: saved.name };
}

export async function saveTelegramInboundFiles(
  phoneE164: string,
  msg: TelegramMessage,
): Promise<void> {
  const photo = largestPhoto(msg);
  if (photo) {
    try {
      const url = await telegramFileUrl(photo.file_id);
      await saveInboundRemoteFile({
        phoneE164,
        url,
        name: `telegram-${msg.message_id}.jpg`,
        mimeType: "image/jpeg",
        sourceChannel: "telegram",
      });
    } catch (err) {
      console.error("save telegram photo failed", err);
    }
  }
  const doc = msg.document;
  if (doc?.file_id) {
    try {
      const url = await telegramFileUrl(doc.file_id);
      await saveInboundRemoteFile({
        phoneE164,
        url,
        name: doc.file_name || `telegram-${msg.message_id}.bin`,
        mimeType: doc.mime_type ?? undefined,
        sourceChannel: "telegram",
      });
    } catch (err) {
      console.error("save telegram document failed", err);
    }
  }
}

export type InboundAttachment = {
  url: string;
  name?: string;
  mimeType?: string;
};

export function attachmentsFromUnknown(value: unknown): InboundAttachment[] {
  if (!value || typeof value !== "object") return [];
  const rec = value as Record<string, unknown>;
  const message = rec.message && typeof rec.message === "object"
    ? (rec.message as Record<string, unknown>)
    : rec;
  const content = message.content && typeof message.content === "object"
    ? (message.content as Record<string, unknown>)
    : undefined;
  const out: InboundAttachment[] = [];
  const raw = content?.attachments ?? message.attachments;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const att = item as Record<string, unknown>;
      const url =
        (typeof att.url === "string" && att.url) ||
        (typeof att.href === "string" && att.href) ||
        "";
      if (!url) continue;
      out.push({
        url,
        name: typeof att.filename === "string" ? att.filename : typeof att.name === "string" ? att.name : undefined,
        mimeType:
          typeof att.mimeType === "string"
            ? att.mimeType
            : typeof att.contentType === "string"
              ? att.contentType
              : undefined,
      });
    }
  }
  if (content?.type === "file" && typeof content.url === "string") {
    out.push({
      url: content.url,
      name: typeof content.filename === "string" ? content.filename : undefined,
      mimeType: typeof content.mimeType === "string" ? content.mimeType : undefined,
    });
  }
  return out;
}

export async function savePhotonInboundFiles(
  phoneE164: string,
  body: unknown,
): Promise<void> {
  const attachments = attachmentsFromUnknown(body);
  for (const att of attachments) {
    try {
      await saveInboundRemoteFile({
        phoneE164,
        url: att.url,
        name: att.name,
        mimeType: att.mimeType,
        sourceChannel: "imessage",
      });
    } catch (err) {
      console.error("save photon attachment failed", err);
    }
  }
}

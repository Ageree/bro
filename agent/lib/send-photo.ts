import { uploadIMessagePhoto, sendBlueIMessageMedia } from "./inkbox.ts";
import { sendTelegramPhoto, sendTelegramPhotoFile } from "./telegram.ts";
import { compileTelegram } from "./telegram-text.ts";
import {
  clipPhotoCaption,
  fetchPhotoBytes,
  photoFromBase64,
  type PhotoBytes,
} from "./outbound-photo.ts";
import {
  assertComputerPath,
  ensureSession,
  readBinaryFile,
} from "./computer.ts";
import { routingFromAuth, type AuthAttrs } from "./turn-routing.ts";
import { claimComputerPhoto, claimUrlPhoto } from "./photo-dedupe.ts";
import type { HumanChannel } from "../../convex/lib/telegramPolicy.ts";

export type SendPhotoTarget = {
  channel: HumanChannel;
  conversationId?: string;
  telegramChatId?: string;
  handle?: string;
  caption?: string;
};

function firstAttr(attrs: AuthAttrs, key: string): string | undefined {
  const raw = attrs?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

export function photoTargetFromAuth(attrs: AuthAttrs): {
  channel: HumanChannel;
  conversationId?: string;
  telegramChatId?: string;
  handle?: string;
} {
  const routing = routingFromAuth(attrs);
  return {
    channel: routing.channel ?? (routing.telegramChatId ? "telegram" : "imessage"),
    conversationId: firstAttr(attrs, "conversationId"),
    telegramChatId: routing.telegramChatId,
    handle: routing.inkboxHandle ?? firstAttr(attrs, "inkboxHandle"),
  };
}

export type SendPhotoDeps = {
  fetchPhoto?: (url: string) => Promise<PhotoBytes>;
  loadComputerPhoto?: (phoneE164: string, path: string) => Promise<PhotoBytes>;
  uploadIMessage?: (opts: {
    content: Uint8Array;
    filename: string;
    contentType: string;
    handle?: string;
  }) => Promise<string>;
  sendIMessageMedia?: typeof sendBlueIMessageMedia;
  sendTelegramUrl?: typeof sendTelegramPhoto;
  sendTelegramFile?: typeof sendTelegramPhotoFile;
};

export async function photoFromComputerPath(
  phoneE164: string,
  path: string,
): Promise<PhotoBytes> {
  const safe = assertComputerPath(path);
  const running = await ensureSession({ phoneE164 });
  const file = await readBinaryFile(running.boxId, safe);
  return photoFromBase64(file.base64, file.path);
}

export async function sendPhotoToHuman(
  opts: SendPhotoTarget & {
    source: { kind: "url"; url: string } | { kind: "bytes"; photo: PhotoBytes };
    deps?: SendPhotoDeps;
  },
): Promise<{ status: "ok"; channel: HumanChannel } | { status: "error"; error: string }> {
  const caption = clipPhotoCaption(opts.caption);
  const chatKey = (opts.conversationId ?? opts.telegramChatId ?? "").trim();
  const channel: HumanChannel =
    opts.channel === "telegram" ? "telegram" : "imessage";
  if (opts.source.kind === "bytes") {
    if (
      !claimComputerPhoto({
        chatKey,
        bytes: opts.source.photo.bytes,
        filename: opts.source.photo.filename,
      })
    ) {
      return { status: "ok", channel };
    }
  } else if (!claimUrlPhoto({ chatKey, url: opts.source.url })) {
    return { status: "ok", channel };
  }
  try {
    if (opts.channel === "telegram") {
      const chatId = opts.telegramChatId?.trim();
      if (!chatId) return { status: "error", error: "нет Telegram-чата для фото" };
      await sendTelegramPhotoSource({
        chatId,
        caption,
        source: opts.source,
        deps: opts.deps,
      });
      return { status: "ok", channel: "telegram" };
    }
    const conversationId = opts.conversationId?.trim();
    if (!conversationId) {
      return { status: "error", error: "нет iMessage-чата для фото" };
    }
    await sendIMessagePhotoSource({
      conversationId,
      handle: opts.handle,
      caption,
      source: opts.source,
      deps: opts.deps,
    });
    return { status: "ok", channel: "imessage" };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "не отправил фото",
    };
  }
}

async function sendTelegramPhotoSource(opts: {
  chatId: string;
  caption?: string;
  source: { kind: "url"; url: string } | { kind: "bytes"; photo: PhotoBytes };
  deps?: SendPhotoDeps;
}): Promise<void> {
  const html = opts.caption ? compileTelegram(opts.caption).html || undefined : undefined;
  if (opts.source.kind === "url") {
    const sendUrl = opts.deps?.sendTelegramUrl ?? sendTelegramPhoto;
    try {
      await sendUrl({ chatId: opts.chatId, url: opts.source.url, html });
      return;
    } catch (err) {
      console.error("telegram photo url failed, uploading bytes", err);
    }
  }
  const photo =
    opts.source.kind === "bytes"
      ? opts.source.photo
      : await (opts.deps?.fetchPhoto ?? fetchPhotoBytes)(opts.source.url);
  const sendFile = opts.deps?.sendTelegramFile ?? sendTelegramPhotoFile;
  await sendFile({
    chatId: opts.chatId,
    bytes: photo.bytes,
    filename: photo.filename,
    contentType: photo.contentType,
    html,
  });
}

async function sendIMessagePhotoSource(opts: {
  conversationId: string;
  handle?: string;
  caption?: string;
  source: { kind: "url"; url: string } | { kind: "bytes"; photo: PhotoBytes };
  deps?: SendPhotoDeps;
}): Promise<void> {
  const photo =
    opts.source.kind === "bytes"
      ? opts.source.photo
      : await (opts.deps?.fetchPhoto ?? fetchPhotoBytes)(opts.source.url);
  const upload = opts.deps?.uploadIMessage ?? uploadIMessagePhoto;
  const mediaUrl = await upload({
    content: photo.bytes,
    filename: photo.filename,
    contentType: photo.contentType,
    handle: opts.handle,
  });
  const sendMedia = opts.deps?.sendIMessageMedia ?? sendBlueIMessageMedia;
  await sendMedia({
    conversationId: opts.conversationId,
    mediaUrls: [mediaUrl],
    handle: opts.handle,
    text: opts.caption,
  });
}

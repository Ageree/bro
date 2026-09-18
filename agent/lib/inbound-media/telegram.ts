import type { TelegramMessage } from "eve/channels/telegram";
import { z } from "zod";
import { env } from "@shared/environment";
import { downloadTimeoutMs, downloadWithin } from "./download";
import {
  audioByteCap,
  baseMediaType,
  inlineImageByteCap,
  isImageMediaType,
  pdfByteCap,
  resolveMediaType,
} from "./media-type";
import { transcribeAudio, transcriptionAvailable } from "./transcription";
import {
  fileNote,
  inboundTurn,
  type InboundMediaItem,
  type InboundTurn,
} from "./turn-content";

/**
 * Inbound Telegram media resolved to bytes before the turn starts. eve's own
 * resolver downloads a photo lazily and drops it when the Bot API serves it
 * without an image content type, which left the model answering blind, and it
 * ignores voice notes entirely.
 */
const telegramApiBaseUrl = "https://api.telegram.org";

const fileSchema = z.object({
  file_id: z.string().min(1),
  file_size: z.number().int().nonnegative().optional(),
});

const photoSizeSchema = fileSchema.extend({
  height: z.number().int().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
});

const documentSchema = fileSchema.extend({
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
});

const voiceSchema = fileSchema.extend({
  mime_type: z.string().optional(),
});

/**
 * The media fields of a Bot API `Message`. Unknown keys are dropped, so a
 * sticker or a video keeps eve's default handling.
 */
const mediaMessageSchema = z.object({
  audio: documentSchema.optional(),
  document: documentSchema.optional(),
  photo: z.array(photoSizeSchema).optional(),
  video_note: fileSchema.optional(),
  voice: voiceSchema.optional(),
});

type PhotoSize = z.infer<typeof photoSizeSchema>;

const getFileResponseSchema = z.object({
  ok: z.literal(true),
  result: z.object({ file_path: z.string().min(1) }),
});

function botToken() {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "Telegram is not configured for this deployment. Set TELEGRAM_BOT_TOKEN."
    );
  }
  return token;
}

/**
 * Picks the largest rendition that eve can still inline for the model, or the
 * smallest one when even that is too big. Telegram reports every size.
 */
function bySize(a: PhotoSize, b: PhotoSize) {
  return (
    (a.file_size ?? 0) - (b.file_size ?? 0) ||
    (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0)
  );
}

export function choosePhotoSize(sizes: readonly PhotoSize[]) {
  const fitting = sizes.filter(
    (size) =>
      size.file_size !== undefined && size.file_size <= inlineImageByteCap
  );
  if (fitting.length > 0) return fitting.toSorted(bySize).at(-1);
  return sizes.toSorted(bySize).at(0);
}

type TelegramDownload =
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly mediaType: string | undefined;
    }
  | { readonly kind: "oversize" }
  | { readonly kind: "failed"; readonly reason: string };

/** Resolves a `file_id` to bytes through `getFile` and the file endpoint. */
async function downloadTelegramFile(
  fileId: string,
  maxBytes: number
): Promise<TelegramDownload> {
  const token = botToken();
  let filePath: string;
  try {
    const response = await fetch(`${telegramApiBaseUrl}/bot${token}/getFile`, {
      body: JSON.stringify({ file_id: fileId }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(downloadTimeoutMs),
    });
    if (!response.ok) {
      return {
        kind: "failed",
        reason: `getFile http ${String(response.status)}`,
      };
    }
    filePath = getFileResponseSchema.parse(await response.json()).result
      .file_path;
  } catch {
    return { kind: "failed", reason: "getFile failed" };
  }
  return downloadWithin(
    new URL(`${telegramApiBaseUrl}/file/bot${token}/${filePath}`),
    maxBytes
  );
}

async function photoItem(
  sizes: readonly PhotoSize[]
): Promise<InboundMediaItem> {
  const size = choosePhotoSize(sizes);
  if (!size) return { kind: "note", text: fileNote("photo.jpg", "image/jpeg") };
  const download = await downloadTelegramFile(size.file_id, inlineImageByteCap);
  if (download.kind !== "bytes") {
    console.warn("[inbound-media] telegram photo", {
      declaredBytes: size.file_size,
      status: download.kind === "oversize" ? "oversize" : download.reason,
    });
    return {
      kind: "note",
      text: fileNote("photo.jpg", "image/jpeg", "не удалось скачать"),
    };
  }
  const mediaType = resolveMediaType(download.bytes, download.mediaType);
  console.info("[inbound-media] telegram photo", {
    bytes: download.bytes.byteLength,
    mediaType,
    status: "ok",
  });
  return {
    data: download.bytes,
    filename: "photo.jpg",
    kind: "image",
    mediaType: isImageMediaType(mediaType) ? mediaType : "image/jpeg",
  };
}

async function documentItem(
  document: z.infer<typeof documentSchema>
): Promise<InboundMediaItem> {
  const declared = baseMediaType(document.mime_type);
  const name = document.file_name ?? "file";
  const isPdf =
    declared === "application/pdf" || name.toLowerCase().endsWith(".pdf");
  if (!isImageMediaType(declared) && !isPdf) {
    return { kind: "note", text: fileNote(document.file_name, declared) };
  }
  const cap = isPdf ? pdfByteCap : inlineImageByteCap;
  if (document.file_size !== undefined && document.file_size > cap) {
    return {
      kind: "note",
      text: fileNote(document.file_name, declared, "слишком большой"),
    };
  }
  const download = await downloadTelegramFile(document.file_id, cap);
  if (download.kind === "oversize") {
    return {
      kind: "note",
      text: fileNote(document.file_name, declared, "слишком большой"),
    };
  }
  if (download.kind === "failed") {
    console.warn("[inbound-media] telegram document", {
      declaredBytes: document.file_size,
      mediaType: declared,
      status: download.reason,
    });
    return {
      kind: "note",
      text: fileNote(document.file_name, declared, "не удалось скачать"),
    };
  }
  const mediaType = resolveMediaType(download.bytes, declared);
  if (mediaType === "application/pdf") {
    return { data: download.bytes, filename: name, kind: "pdf" };
  }
  if (isImageMediaType(mediaType)) {
    return { data: download.bytes, filename: name, kind: "image", mediaType };
  }
  return { kind: "note", text: fileNote(document.file_name, mediaType) };
}

async function voiceItem(
  file: z.infer<typeof fileSchema>,
  declared: string | undefined,
  filename: string | undefined
): Promise<InboundMediaItem> {
  if (!transcriptionAvailable()) return { kind: "voice-unsupported" };
  const download = await downloadTelegramFile(file.file_id, audioByteCap);
  if (download.kind !== "bytes") {
    console.warn("[inbound-media] telegram voice", {
      declaredBytes: file.file_size,
      status: download.kind === "oversize" ? "oversize" : download.reason,
    });
    return { kind: "voice-failed" };
  }
  const transcript = await transcribeAudio({
    bytes: download.bytes,
    filename,
    mediaType: declared ?? download.mediaType,
  });
  return transcript.kind === "transcript"
    ? { kind: "transcript", text: transcript.text }
    : { kind: "voice-failed" };
}

/**
 * The turn for a Telegram message that carries a photo, document, voice note,
 * audio file, or video note, or `undefined` when it carries none and eve's
 * default text turn applies.
 */
export async function telegramMediaTurn(
  message: TelegramMessage
): Promise<InboundTurn | undefined> {
  const parsed = mediaMessageSchema.safeParse(message.raw);
  if (!parsed.success) return undefined;
  const media = parsed.data;
  const tasks: Promise<InboundMediaItem>[] = [];
  if (media.photo && media.photo.length > 0) tasks.push(photoItem(media.photo));
  if (media.document) tasks.push(documentItem(media.document));
  if (media.voice) {
    tasks.push(
      voiceItem(media.voice, baseMediaType(media.voice.mime_type), undefined)
    );
  }
  if (media.audio) {
    tasks.push(
      voiceItem(
        media.audio,
        baseMediaType(media.audio.mime_type),
        media.audio.file_name
      )
    );
  }
  if (media.video_note)
    tasks.push(voiceItem(media.video_note, "video/mp4", "note.mp4"));
  if (tasks.length === 0) return undefined;
  const items = await Promise.all(tasks);
  return inboundTurn(message.text || message.caption, items);
}

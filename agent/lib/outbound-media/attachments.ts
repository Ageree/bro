/**
 * Outbound attachment uploads. `send_message` names a file by HTTPS URL, and a
 * channel that can upload bytes needs the file itself, decided from the bytes
 * rather than from what the model declared. Nothing here is channel-specific,
 * and nothing here logs the URL.
 */

import { isIP } from "node:net";
import type { MessageAttachment } from "@shared/chat/message-delivery";
import { downloadWithin } from "../inbound-media/download";
import { resolveMediaType } from "../inbound-media/media-type";

/**
 * Telegram refuses a photo upload past 10 MB, which is also the cap the
 * inbound Telegram `uploadPolicy` applies. A document could go to 50 MB there,
 * but the bytes are buffered in the function that delivers the reply, so the
 * lower cap is what keeps one message from exhausting its memory.
 */
export const maximumAttachmentBytes = 10 * 1024 * 1024;
/** Ten files at the per-file cap would peak far above that same memory. */
export const maximumAttachmentBatchBytes = 30 * 1024 * 1024;
/** How many downloads are in flight at once, which bounds the peak. */
const attachmentDownloadConcurrency = 3;

/** Long enough for a descriptive name, short enough for every messenger. */
const maximumFilenameLength = 120;
/** Beyond this a trailing dot is part of the name, not an extension. */
const maximumExtensionLength = 16;
/** Control and format characters, and the separators that make a name a path. */
const unsafeFilenameCharacters = /[\p{Cc}\p{Cf}/\\]/gu;

/** How a channel that distinguishes media has to upload these bytes. */
type OutboundFileKind = "audio" | "document" | "photo" | "video";

export interface OutboundFile {
  readonly data: Buffer;
  readonly filename: string;
  readonly kind: OutboundFileKind;
  readonly mimeType: string;
  /**
   * The attachment URL the bytes came from, which a channel falls back to as a
   * link when the upload itself fails. An image artifact has no public URL.
   */
  readonly sourceUrl?: string;
}

/** An attachment that stays a link, with a reason short enough to log. */
interface AttachmentFailure {
  readonly reason: string;
  readonly url: string;
}

/** Telegram renders these inline as a photo; every other image uploads as a file. */
const photoMediaTypes: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** A page is not a file: uploading it would hand the person the markup. */
const pageMediaTypes: ReadonlySet<string> = new Set([
  "application/xhtml+xml",
  "text/html",
]);

const mediaTypeExtensions: ReadonlyMap<string, string> = new Map([
  ["application/pdf", ".pdf"],
  ["audio/aac", ".aac"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/ogg", ".ogg"],
  ["audio/wav", ".wav"],
  ["audio/x-caf", ".caf"],
  ["image/bmp", ".bmp"],
  ["image/gif", ".gif"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/svg+xml", ".svg"],
  ["image/tiff", ".tiff"],
  ["image/webp", ".webp"],
  ["video/mp4", ".mp4"],
  ["video/mpeg", ".mpeg"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
]);

/**
 * Downloads every attachment and turns it into bytes a channel can upload. One
 * attachment that cannot be fetched only costs its own upload: it comes back as
 * a failure the caller delivers as a link, which is what every channel did
 * before uploads existed. Downloads run a few at a time and stop once the
 * message has spent its byte budget, so a reply cannot buffer its way out of
 * memory.
 */
/* oxlint-disable eslint/no-await-in-loop -- Each batch is awaited so the next one sees what the message has spent. */
export async function prepareAttachmentDelivery(
  attachments: readonly MessageAttachment[]
): Promise<{
  readonly failures: readonly AttachmentFailure[];
  readonly files: readonly OutboundFile[];
}> {
  if (attachments.length === 0) return { failures: [], files: [] };
  const queued = attachments.map((attachment, index) => ({
    attachment,
    index,
  }));
  const prepared: (OutboundFile | AttachmentFailure)[] = [];
  let spent = 0;
  for (const batch of batched(queued, attachmentDownloadConcurrency)) {
    const exhausted = spent >= maximumAttachmentBatchBytes;
    const settled = await Promise.all(
      batch.map(async ({ attachment, index }) =>
        exhausted
          ? { reason: "batch-oversize", url: attachment.url }
          : // One attachment that breaks in an unforeseen way stays one link,
            // rather than failing the turn that was delivering the reply.
            prepareAttachment(attachment, index).catch(
              (): AttachmentFailure => ({
                reason: "unexpected",
                url: attachment.url,
              })
            )
      )
    );
    for (const item of settled) {
      if ("reason" in item) {
        prepared.push(item);
      } else if (spent + item.data.byteLength > maximumAttachmentBatchBytes) {
        prepared.push({ reason: "batch-oversize", url: item.sourceUrl });
      } else {
        spent += item.data.byteLength;
        prepared.push(item);
      }
    }
  }
  return {
    failures: prepared.flatMap((item) =>
      "reason" in item ? [{ reason: item.reason, url: item.url }] : []
    ),
    files: prepared.flatMap((item) => ("reason" in item ? [] : [item])),
  };
}
/* oxlint-enable eslint/no-await-in-loop */

function* batched<TItem>(items: readonly TItem[], size: number) {
  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
}

async function prepareAttachment(
  attachment: MessageAttachment,
  index: number
): Promise<
  AttachmentFailure | (OutboundFile & { readonly sourceUrl: string })
> {
  const url = URL.parse(attachment.url);
  if (!url) return { reason: "invalid-url", url: attachment.url };
  if (url.protocol !== "https:") {
    return { reason: "not-https", url: attachment.url };
  }
  if (isBlockedHost(url.hostname)) {
    return { reason: "blocked-host", url: attachment.url };
  }

  const download = await downloadWithin(url, maximumAttachmentBytes, {
    allowUrl: (next) => !isBlockedHost(next.hostname),
  });
  if (download.kind !== "bytes") {
    const reason = download.kind === "oversize" ? "oversize" : download.reason;
    return { reason, url: attachment.url };
  }
  if (download.bytes.byteLength === 0) {
    return { reason: "empty", url: attachment.url };
  }
  const mediaType = resolveMediaType(
    download.bytes,
    download.mediaType ?? attachment.mimeType
  );
  if (!mediaType) return { reason: "unknown-media-type", url: attachment.url };
  if (pageMediaTypes.has(mediaType) || startsPage(download.bytes)) {
    return { reason: "not-a-file", url: attachment.url };
  }

  return {
    // The body was read into an exact-size buffer, so this views it rather
    // than copying another ten megabytes.
    data: Buffer.from(
      download.bytes.buffer,
      download.bytes.byteOffset,
      download.bytes.byteLength
    ),
    filename: attachmentFilename(attachment, index, mediaType),
    kind: outboundFileKind(mediaType),
    mimeType: mediaType,
    sourceUrl: attachment.url,
  };
}

/**
 * Rejects the hosts an outbound fetch must never reach, on the URL the model
 * supplied and on every redirect hop. No name is resolved here, so a hostname
 * pointing at a private address is not caught; the deployment's egress rules
 * are the backstop for that.
 */
function isBlockedHost(hostname: string) {
  const host = hostname
    .replace(/^\[(?<address>.*)\]$/u, "$<address>")
    .toLowerCase()
    .replace(/\.$/u, "");
  if (isIP(host) !== 0) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return host.endsWith(".local") || host.endsWith(".internal");
}

/** Markup a server handed back under any media type it liked. */
function startsPage(bytes: Uint8Array) {
  const head = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, 64)
  )
    .toString("utf8")
    .replace(/^\uFEFF/u, "")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

export function outboundFileKind(mediaType: string): OutboundFileKind {
  if (photoMediaTypes.has(mediaType)) return "photo";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  // A GIF, HEIC or SVG is an image no photo endpoint accepts as one.
  return "document";
}

/**
 * The name the recipient sees: what the model asked for, the file the URL
 * names, or a plain placeholder. The extension follows the resolved media type
 * so a messenger does not render a PDF as a broken image.
 */
function attachmentFilename(
  attachment: MessageAttachment,
  index: number,
  mediaType: string
) {
  const chosen = safeFilename(
    attachment.name ?? urlFilename(attachment.url) ?? ""
  );
  const name = chosen || `attachment-${String(index + 1)}`;
  return capFilename(withExtension(name, mediaType));
}

/** A filename cannot reach outside its folder or rewrite the line it renders on. */
function safeFilename(name: string) {
  return name.replace(unsafeFilenameCharacters, "").trim();
}

function urlFilename(url: string) {
  const segment = URL.parse(url)?.pathname.split("/").at(-1);
  if (!segment) return undefined;
  try {
    const decoded = decodeURIComponent(segment).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function withExtension(name: string, mediaType: string) {
  const extension = mediaTypeExtensions.get(mediaType);
  if (!extension) return name;
  if (name.toLowerCase().endsWith(extension)) return name;
  const dot = name.lastIndexOf(".");
  // A long tail after the last dot is part of the name — `2024.06.wedding`
  // keeps its date rather than losing everything after the first separator.
  const replaceable = dot > 0 && name.length - dot <= 6;
  return `${replaceable ? name.slice(0, dot) : name}${extension}`;
}

/** Shortens a name past what every messenger shows, keeping its extension. */
export function capFilename(name: string) {
  if (name.length <= maximumFilenameLength) return name;
  const dot = name.lastIndexOf(".");
  const extension =
    dot > 0 && name.length - dot <= maximumExtensionLength
      ? name.slice(dot)
      : "";
  const stem = Math.max(1, maximumFilenameLength - extension.length);
  return `${name.slice(0, stem)}${extension}`;
}

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
 * inbound Telegram `uploadPolicy` applies.
 */
export const maximumAttachmentBytes = 10 * 1024 * 1024;

/** Long enough for a descriptive name, short enough for every messenger. */
const maximumFilenameLength = 120;

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

/** Pages are not files: an upload would hand the person the markup instead. */
const documentMediaTypes: ReadonlySet<string> = new Set([
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
 * before uploads existed.
 */
export async function prepareAttachmentDelivery(
  attachments: readonly MessageAttachment[]
): Promise<{
  readonly failures: readonly AttachmentFailure[];
  readonly files: readonly OutboundFile[];
}> {
  if (attachments.length === 0) return { failures: [], files: [] };
  const prepared = await Promise.all(
    attachments.map(async (attachment, index) =>
      prepareAttachment(attachment, index)
    )
  );
  return {
    failures: prepared.flatMap((item) =>
      "reason" in item ? [{ reason: item.reason, url: item.url }] : []
    ),
    files: prepared.flatMap((item) => ("reason" in item ? [] : [item])),
  };
}

async function prepareAttachment(
  attachment: MessageAttachment,
  index: number
): Promise<OutboundFile | AttachmentFailure> {
  const url = URL.parse(attachment.url);
  if (!url) return { reason: "invalid-url", url: attachment.url };
  if (url.protocol !== "https:") {
    return { reason: "not-https", url: attachment.url };
  }
  if (isBlockedHost(url.hostname)) {
    return { reason: "blocked-host", url: attachment.url };
  }

  const download = await downloadWithin(url, maximumAttachmentBytes);
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
  if (documentMediaTypes.has(mediaType)) {
    return { reason: "not-a-file", url: attachment.url };
  }

  return {
    data: Buffer.from(download.bytes),
    filename: attachmentFilename(attachment, index, mediaType),
    kind: outboundFileKind(mediaType),
    mimeType: mediaType,
    sourceUrl: attachment.url,
  };
}

/**
 * Rejects the hosts an outbound fetch must never reach. No name is resolved
 * here, so a hostname pointing at a private address is not caught; the
 * deployment's egress rules are the backstop for that.
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

function outboundFileKind(mediaType: string): OutboundFileKind {
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
  const name =
    attachment.name ??
    urlFilename(attachment.url) ??
    `attachment-${String(index + 1)}`;
  return capFilename(withExtension(name, mediaType));
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
  return `${dot > 0 ? name.slice(0, dot) : name}${extension}`;
}

function capFilename(name: string) {
  if (name.length <= maximumFilenameLength) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const stem = Math.max(1, maximumFilenameLength - extension.length);
  return `${name.slice(0, stem)}${extension}`;
}

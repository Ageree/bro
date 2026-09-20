/** Inbound iMessage photos reach the model as image parts, not as URLs in
 *  text. `deepseek/deepseek-v4.1-flash` has vision; a signed Inkbox URL in plain text
 *  is invisible to it («найди эту книгу» + photo got nothing).
 *
 *  Bytes are downloaded here so the image stays valid in session history
 *  after the signed URL expires. Oversize or failed downloads fall back to
 *  the plain URL string, which the provider fetches itself.
 *
 *  Every part built here MUST stay plain JSON (string/number/boolean/null,
 *  plain arrays/objects only) — never `Uint8Array` or `URL`. eve hands the
 *  raw turn input to every memory slot's tool resolver, which serialises it
 *  with a strict JSON check (`memory-tools.js`: `parseJsonObject`); a
 *  non-JSON value throws "Expected a JSON-serializable value" and silently
 *  drops the memo/recall/archive tools for that turn (incident 2026-09-06:
 *  `data: Uint8Array` / `data: new URL(...)` broke all three memory tools
 *  on every inbound photo). The AI SDK accepts a plain string for
 *  `FilePart.data` just as well — a `data:` URL string is split into
 *  inline base64, any other URL-shaped string becomes a url part — so
 *  strings are fully equivalent and JSON-safe. */

import { readLimited } from "./voice.ts";
import { publicHttpUrl } from "./public-host.ts";

export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
/** Download budget for one inbound photo. 800 ms was a latency guess the photo
 *  kept losing: a webhook that misses it hands the model a URL instead of the
 *  picture, and a URL is the one thing the model cannot see. The fast-ack
 *  bubble is already out by then, so the extra second is not a second anybody
 *  watches. */
export const IMAGE_TIMEOUT_MS = 2_000;

/** How many photos of one message ride into the turn inline. Each is up to
 *  3 MB that becomes ~4 MB of base64 in the turn input, and eve hands that
 *  input to the queue whole — an album would push the turn itself over the
 *  edge. The rest are still saved to the person's files. */
export const MAX_INLINE_IMAGES = 3;

/** Stands in for the caption when a photo arrives without one. An empty text
 *  with an image part reads as an empty message to every gate on the way in —
 *  on Photon it never reached the agent at all. */
export const PHOTO_ONLY_TEXT = "[фото]";

/** Marks a photo that arrived but could not be read, so the model answers the
 *  caption knowing it is answering blind instead of describing a picture it
 *  never got. */
export const PHOTO_UNREADABLE_TEXT = "[фото не удалось загрузить]";

export type InboundMediaItem = {
  url?: string | null;
  content_type?: string | null;
  size?: number | null;
  /** Original filename, when the channel sends one. */
  name?: string | null;
};

export type InboundImage = { url: string; mediaType: string; size: number | null };

export function isImageContentType(contentType: string | null | undefined): boolean {
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("image/");
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** A type that tells us nothing: absent, blank, or the generic byte bucket a
 *  CDN sends when it did not look. Photon attachments arrive as `{ url }` and
 *  nothing else. */
function typeUnknown(contentType: string | null | undefined): boolean {
  const ct = contentType?.trim().toLowerCase().split(";")[0].trim();
  return !ct || ct === "application/octet-stream" || ct === "binary/octet-stream";
}

/** Media type read off a filename or URL path, for attachments that declare
 *  none. Without it a photo whose webhook carried no content type was dropped
 *  as «not an image» and the model answered the caption alone. */
export function imageMediaTypeFromName(
  nameOrUrl: string | null | undefined,
): string | undefined {
  const raw = nameOrUrl?.trim();
  if (!raw) return undefined;
  let path = raw;
  try {
    path = new URL(raw).pathname;
  } catch {
    // Plain filename, not a URL.
  }
  const ext = path.toLowerCase().split(/[?#]/)[0]!.split(".").pop();
  return ext ? IMAGE_EXTENSIONS[ext] : undefined;
}

/** Image attachments in webhook order. Audio and other files are ignored: a
 *  declared non-image type is the sender's word and settles it, and only a
 *  missing one falls back to the filename. */
export function inboundImages(media: InboundMediaItem[] | null | undefined): InboundImage[] {
  const out: InboundImage[] = [];
  for (const m of media ?? []) {
    const url = m.url?.trim();
    if (!url) continue;
    const mediaType = isImageContentType(m.content_type)
      ? m.content_type!.toLowerCase().split(";")[0].trim()
      : typeUnknown(m.content_type)
        ? imageMediaTypeFromName(m.name) ?? imageMediaTypeFromName(url)
        : undefined;
    if (!mediaType) continue;
    out.push({
      url,
      mediaType,
      size: typeof m.size === "number" ? m.size : null,
    });
  }
  return out;
}

/** AI SDK `FilePart` for one image: a `data:` base64 string when small
 *  enough, else the plain URL string. `data` is always a JSON-safe string —
 *  see the header comment. */
export type ImagePart = {
  type: "file";
  mediaType: string;
  data: string;
};

export async function fetchImagePart(
  image: InboundImage,
  deps: { fetch?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<ImagePart> {
  const doFetch = deps.fetch ?? fetch;
  const maxBytes = deps.maxBytes ?? IMAGE_MAX_BYTES;
  const timeoutMs = deps.timeoutMs ?? IMAGE_TIMEOUT_MS;
  const byUrl: ImagePart = { type: "file", mediaType: image.mediaType, data: image.url };
  if (image.size !== null && image.size > maxBytes) return byUrl;
  if (!publicHttpUrl(image.url)) return byUrl;
  try {
    const res = await doFetch(image.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return byUrl;
    const body = await readLimited(res, maxBytes);
    if ("error" in body) return byUrl;
    const mediaType = res.headers.get("content-type")?.split(";")[0].trim() || image.mediaType;
    const resolvedMediaType = isImageContentType(mediaType) ? mediaType : image.mediaType;
    return {
      type: "file",
      mediaType: resolvedMediaType,
      data: `data:${resolvedMediaType};base64,${Buffer.from(body).toString("base64")}`,
    };
  } catch {
    return byUrl;
  }
}

export function isPlainJson(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "boolean" || t === "string") return true;
  if (t === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJson);
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every(isPlainJson);
  }
  return false;
}

export function assembleInboundContent(
  text: string,
  parts: readonly ImagePart[],
): string | Array<{ type: "text"; text: string } | ImagePart> {
  if (parts.length === 0) return text;
  // An empty text part is not free: some providers reject it outright, and the
  // ones that do not still bill it. A photo with no caption is just the photo.
  return text.trim() ? [{ type: "text", text }, ...parts] : [...parts];
}

export function imageUrlParts(
  media: InboundMediaItem[] | null | undefined,
): ImagePart[] {
  return inboundImages(media).map((img) => ({
    type: "file",
    mediaType: img.mediaType,
    data: img.url,
  }));
}

/** The parts whose bytes we actually hold. A part that is still a URL is one
 *  the download did not finish in budget — and a Telegram file URL is the bot
 *  token spelled out, so that one must never travel to a model host. */
export function inlineImageParts(parts: readonly ImagePart[]): ImagePart[] {
  return parts.filter((part) => part.data.startsWith("data:"));
}

export function prefetchImageParts(
  images: readonly InboundImage[],
  deps: Parameters<typeof fetchImagePart>[1] = {},
): Promise<ImagePart[]> {
  return Promise.all(images.map((img) => fetchImagePart(img, deps)));
}

export function prefetchInboundImages(
  media: InboundMediaItem[] | null | undefined,
  deps: Parameters<typeof fetchImagePart>[1] = {},
): Promise<ImagePart[]> {
  return prefetchImageParts(inboundImages(media), deps);
}

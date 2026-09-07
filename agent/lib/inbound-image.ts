/** Inbound iMessage photos reach the model as image parts, not as URLs in
 *  text. `z-ai/glm-5.3-flash` has vision; a signed Inkbox URL in plain text
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

export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 800;

export type InboundMediaItem = {
  url?: string | null;
  content_type?: string | null;
  size?: number | null;
};

export type InboundImage = { url: string; mediaType: string; size: number | null };

export function isImageContentType(contentType: string | null | undefined): boolean {
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("image/");
}

/** Image attachments in webhook order. Audio and other files are ignored. */
export function inboundImages(media: InboundMediaItem[] | null | undefined): InboundImage[] {
  const out: InboundImage[] = [];
  for (const m of media ?? []) {
    const url = m.url?.trim();
    if (!url || !isImageContentType(m.content_type)) continue;
    out.push({
      url,
      mediaType: m.content_type!.toLowerCase().split(";")[0].trim(),
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

/** Recursively true only for plain-JSON-serialisable values: null, boolean,
 *  string, finite number, plain arrays, and plain objects (prototype is
 *  `Object.prototype` or `null`). Everything else — `Uint8Array`, `URL`,
 *  `Date`, `Map`, `NaN`, `undefined`, class instances — is false. Used by
 *  the check script to pin `inboundUserContent`'s output shape; not called
 *  at runtime in the channel. */
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
  return [{ type: "text", text }, ...parts];
}

export function prefetchInboundImages(
  media: InboundMediaItem[] | null | undefined,
  deps: Parameters<typeof fetchImagePart>[1] = {},
): Promise<ImagePart[]> {
  return Promise.all(inboundImages(media).map((img) => fetchImagePart(img, deps)));
}

/** Text + image parts, or plain text when there is nothing to see. Always
 *  plain JSON — see the header comment. */
export async function inboundUserContent(
  text: string,
  media: InboundMediaItem[] | null | undefined,
  deps: Parameters<typeof fetchImagePart>[1] = {},
): Promise<string | Array<{ type: "text"; text: string } | ImagePart>> {
  return assembleInboundContent(text, await prefetchInboundImages(media, deps));
}

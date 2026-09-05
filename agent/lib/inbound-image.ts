/** Inbound iMessage photos reach the model as image parts, not as URLs in
 *  text. `z-ai/glm-5.3-flash` has vision; a signed Inkbox URL in plain text
 *  is invisible to it («найди эту книгу» + photo got nothing).
 *
 *  Bytes are downloaded here so the image stays valid in session history
 *  after the signed URL expires. Oversize or failed downloads fall back to
 *  a URL part, which the provider fetches itself. */

import { readLimited } from "./voice.ts";

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 10_000;

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

/** AI SDK `FilePart` for one image: bytes when small enough, else the URL. */
export type ImagePart = {
  type: "file";
  mediaType: string;
  data: Uint8Array | URL;
};

export async function fetchImagePart(
  image: InboundImage,
  deps: { fetch?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<ImagePart> {
  const doFetch = deps.fetch ?? fetch;
  const maxBytes = deps.maxBytes ?? IMAGE_MAX_BYTES;
  const timeoutMs = deps.timeoutMs ?? IMAGE_TIMEOUT_MS;
  const byUrl: ImagePart = { type: "file", mediaType: image.mediaType, data: new URL(image.url) };
  if (image.size !== null && image.size > maxBytes) return byUrl;
  try {
    const res = await doFetch(image.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return byUrl;
    const body = await readLimited(res, maxBytes);
    if ("error" in body) return byUrl;
    const mediaType = res.headers.get("content-type")?.split(";")[0].trim() || image.mediaType;
    return {
      type: "file",
      mediaType: isImageContentType(mediaType) ? mediaType : image.mediaType,
      data: body,
    };
  } catch {
    return byUrl;
  }
}

/** Text + image parts, or plain text when there is nothing to see. */
export async function inboundUserContent(
  text: string,
  media: InboundMediaItem[] | null | undefined,
  deps: Parameters<typeof fetchImagePart>[1] = {},
): Promise<string | Array<{ type: "text"; text: string } | ImagePart>> {
  const images = inboundImages(media);
  if (images.length === 0) return text;
  const parts = await Promise.all(images.map((img) => fetchImagePart(img, deps)));
  return [{ type: "text", text }, ...parts];
}

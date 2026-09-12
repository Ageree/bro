import { posix as posixPath } from "node:path";
import { readLimited } from "./voice.ts";

export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const PHOTO_FETCH_TIMEOUT_MS = 15_000;
export const PHOTO_CAPTION_MAX = 1024;

const IMAGE_MARKDOWN = /!{1,2}\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi;

export const PHOTO_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type PhotoContentType = (typeof PHOTO_TYPES)[number];

export type PhotoBytes = {
  bytes: Uint8Array;
  filename: string;
  contentType: PhotoContentType;
};

export type SendPhotoSource =
  | { kind: "url"; url: string }
  | { kind: "file"; fileId?: string; name?: string };

export function extractMarkdownPhotoUrls(src: string): string[] {
  const photos: string[] = [];
  const re = new RegExp(IMAGE_MARKDOWN.source, "gi");
  for (const match of src.matchAll(re)) {
    const url = match[2]?.trim();
    if (url) photos.push(url);
  }
  return photos;
}

export function stripMarkdownPhotos(src: string): string {
  return src
    .replace(new RegExp(IMAGE_MARKDOWN.source, "gi"), "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const STORED_FILE_REF =
  /(?:^|[\s`'"(\[]|:\s*)file:([^\s`'")\]]+\.(?:jpg|jpeg|png|gif|webp))\b/gi;

export function extractStoredFileRefs(src: string): string[] {
  const out: string[] = [];
  const re = new RegExp(STORED_FILE_REF.source, "gi");
  for (const match of src.matchAll(re)) {
    const name = match[1]?.trim();
    if (name && imageMetaFromName(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

export function stripStoredFileRefs(src: string): string {
  return src
    .replace(new RegExp(STORED_FILE_REF.source, "gi"), " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isPhotoContentType(
  value: string | null | undefined,
): value is PhotoContentType {
  const mime = (value ?? "").split(";")[0].trim().toLowerCase();
  return (PHOTO_TYPES as readonly string[]).includes(mime);
}

export function imageMetaFromName(
  name: string,
): { filename: string; contentType: PhotoContentType } | null {
  const filename = posixPath.basename(name.trim()) || "photo.jpg";
  const ext = posixPath.extname(filename).toLowerCase();
  const contentType =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".png"
        ? "image/png"
        : ext === ".gif"
          ? "image/gif"
          : ext === ".webp"
            ? "image/webp"
            : null;
  if (!contentType) return null;
  return { filename, contentType };
}

export function sniffImage(bytes: Uint8Array): PhotoContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function assertPublicPhotoUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("нужен https URL картинки");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("нужен https URL картинки");
  }
  return parsed.toString();
}

export function parseSendPhotoInput(input: {
  path?: string;
  name?: string;
  fileId?: string;
  url?: string;
}): SendPhotoSource | { error: string } {
  const path = input.path?.trim() ?? "";
  const name = input.name?.trim() || (path ? posixPath.basename(path) : "");
  const fileId = input.fileId?.trim() ?? "";
  const url = input.url?.trim() ?? "";
  if (url && (fileId || name)) return { error: "укажи либо файл, либо url — не оба" };
  if (url) {
    try {
      return { kind: "url", url: assertPublicPhotoUrl(url) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "нужен https URL картинки" };
    }
  }
  if (fileId || name) {
    return {
      kind: "file",
      ...(fileId ? { fileId } : {}),
      ...(name ? { name } : {}),
    };
  }
  return { error: "нужен fileId, имя файла или https URL" };
}

export function photoFromBytes(
  bytes: Uint8Array,
  name: string,
  declaredType?: string | null,
): PhotoBytes {
  if (bytes.byteLength === 0) throw new Error("пустой файл картинки");
  if (bytes.byteLength > PHOTO_MAX_BYTES) {
    throw new Error("картинка больше 8 МБ");
  }
  const sniffed = sniffImage(bytes);
  const named = imageMetaFromName(name);
  const declared = isPhotoContentType(declaredType) ? declaredType : null;
  const contentType = sniffed ?? declared ?? named?.contentType;
  if (!contentType) throw new Error("это не картинка");
  const filename = named?.filename ?? `photo.${extensionFor(contentType)}`;
  return { bytes, filename, contentType };
}

export function photoFromBase64(
  base64: string,
  name: string,
  declaredType?: string | null,
): PhotoBytes {
  const trimmed = base64.trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(trimmed) || trimmed.length === 0) {
    throw new Error("файл картинки не читается");
  }
  return photoFromBytes(Buffer.from(trimmed, "base64"), name, declaredType);
}

export function clipPhotoCaption(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, PHOTO_CAPTION_MAX);
}

export async function fetchPhotoBytes(
  url: string,
  deps: { fetch?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<PhotoBytes> {
  const href = assertPublicPhotoUrl(url);
  const doFetch = deps.fetch ?? fetch;
  const maxBytes = deps.maxBytes ?? PHOTO_MAX_BYTES;
  const res = await doFetch(href, {
    signal: AbortSignal.timeout(deps.timeoutMs ?? PHOTO_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`не скачал картинку (${res.status})`);
  const body = await readLimited(res, maxBytes);
  if ("error" in body) throw new Error("картинка больше 8 МБ");
  const headerType = res.headers.get("content-type");
  return photoFromBytes(body, filenameFromUrl(href), headerType);
}

function filenameFromUrl(url: string): string {
  try {
    const name = posixPath.basename(new URL(url).pathname);
    return name || "photo.jpg";
  } catch {
    return "photo.jpg";
  }
}

function extensionFor(type: PhotoContentType): string {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/gif") return "gif";
  return "webp";
}

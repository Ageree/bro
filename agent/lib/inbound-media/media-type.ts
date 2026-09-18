/**
 * Media types the inbound channels can hand to the model, decided from the
 * bytes rather than from what a messenger declared: a Telegram photo is served
 * as `application/octet-stream`, an iMessage voice note arrives as a `.caf`
 * with a `mimeType` that may be missing, and a mismatch makes eve or the model
 * drop the part.
 */

/** eve inlines an image into the model context only up to this size. */
export const inlineImageByteCap = 3 * 1024 * 1024;
/** Matches the Telegram channel's `uploadPolicy` for PDFs. */
export const pdfByteCap = 10 * 1024 * 1024;
/** OpenRouter's transcription endpoint stops accepting audio around here. */
export const audioByteCap = 25 * 1024 * 1024;

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]) {
  return prefix.every((byte, index) => bytes[index] === byte);
}

const isoBrandMediaTypes: ReadonlyMap<string, string> = new Map([
  ["M4A ", "audio/mp4"],
  ["heic", "image/heic"],
  ["heix", "image/heic"],
  ["hevc", "image/heic"],
  ["hevx", "image/heic"],
  ["isom", "audio/mp4"],
  ["mif1", "image/heif"],
  ["mp41", "audio/mp4"],
  ["mp42", "audio/mp4"],
  ["msf1", "image/heif"],
]);

/**
 * Reads the media type from the file's magic bytes. Images, PDFs and the audio
 * containers messengers send are recognised; anything else is `undefined` so
 * the caller falls back to the declared type.
 */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  const head = ascii(bytes, 0, 4);
  if (head === "GIF8") return "image/gif";
  if (head === "RIFF") {
    const form = ascii(bytes, 8, 4);
    if (form === "WEBP") return "image/webp";
    if (form === "WAVE") return "audio/wav";
    return undefined;
  }
  if (head === "%PDF") return "application/pdf";
  if (head === "caff") return "audio/x-caf";
  if (head === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    return isoBrandMediaTypes.get(ascii(bytes, 8, 4));
  }
  return undefined;
}

/** The media type before any `; charset=` or codec parameters, lower-cased. */
export function baseMediaType(value: string | null | undefined) {
  const base = (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return base.length > 0 ? base : undefined;
}

export function isImageMediaType(
  mediaType: string | undefined
): mediaType is `image/${string}` {
  return mediaType?.startsWith("image/") === true;
}

export function isAudioMediaType(
  mediaType: string | undefined
): mediaType is `audio/${string}` {
  return mediaType?.startsWith("audio/") === true;
}

/**
 * The type the model receives: what the bytes say, or the declared type when
 * the signature is unknown. A declared image that sniffs as audio is trusted
 * as audio, because the bytes are what the model will decode.
 */
export function resolveMediaType(
  bytes: Uint8Array,
  declared: string | null | undefined
) {
  return sniffMediaType(bytes) ?? baseMediaType(declared);
}

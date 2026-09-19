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

/**
 * ISO base media brands that pin a type. The generic `isom`, `mp41` and `mp42`
 * brands are shared by videos and audio files, so they are left to the
 * declared type rather than sending a video to transcription.
 */
const isoBrandMediaTypes: ReadonlyMap<string, string> = new Map([
  ["M4A ", "audio/mp4"],
  ["heic", "image/heic"],
  ["heix", "image/heic"],
  ["hevc", "image/heic"],
  ["hevx", "image/heic"],
  ["mif1", "image/heif"],
  ["msf1", "image/heif"],
]);

/**
 * Frame sync at the top of raw MPEG audio and ADTS AAC. Both begin with
 * eleven set bits; the layer bits then tell them apart, because ADTS always
 * carries the reserved layer `00` and an MPEG audio frame never does.
 */
function frameSyncMediaType(bytes: Uint8Array) {
  const second = bytes[1] ?? 0;
  if (bytes[0] !== 0xff || (second & 0xe0) !== 0xe0) return undefined;
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  if (layer === 0) {
    return (second & 0xf0) === 0xf0 ? "audio/aac" : undefined;
  }
  return version === 1 ? undefined : "audio/mpeg";
}

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
  if (ascii(bytes, 4, 4) === "ftyp") {
    return isoBrandMediaTypes.get(ascii(bytes, 8, 4));
  }
  return frameSyncMediaType(bytes);
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

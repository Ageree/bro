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
export const pdfByteCap = 20 * 1024 * 1024;
/**
 * OpenRouter's transcription endpoint stops accepting audio around here.
 * RouterAI's limit was not measured, so the same cap applies there.
 */
export const audioByteCap = 25 * 1024 * 1024;
/**
 * A spreadsheet, document or text file the person sends for the task agent
 * (TASK_FILES_WORKSPACES); the object store's copy for the task agent
 * (`attachmentByteCap` in `agent/lib/sandbox/inbox.ts`) takes this cap.
 */
export const documentByteCap = 20 * 1024 * 1024;

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

/**
 * What a document's bytes must be for its extension to be believed: an OOXML
 * or OpenDocument package (both zips), an OLE compound file, or text.
 */
type DocumentContainer = "cfb" | "odf" | "ooxml" | "text";

/**
 * The documents the task agent can open, by extension: the canonical media
 * type and the container its bytes come in. Nothing here is an image or a
 * PDF, which the model reads itself; archives, executables and videos are
 * left out on purpose and stay a one-line note.
 */
const documentTypes: ReadonlyMap<
  string,
  { readonly container: DocumentContainer; readonly mediaType: string }
> = new Map([
  [
    "xlsx",
    {
      container: "ooxml",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  ],
  [
    "xlsm",
    {
      container: "ooxml",
      mediaType: "application/vnd.ms-excel.sheet.macroEnabled.12",
    },
  ],
  ["xls", { container: "cfb", mediaType: "application/vnd.ms-excel" }],
  ["csv", { container: "text", mediaType: "text/csv" }],
  ["tsv", { container: "text", mediaType: "text/tab-separated-values" }],
  [
    "docx",
    {
      container: "ooxml",
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ],
  ["doc", { container: "cfb", mediaType: "application/msword" }],
  [
    "pptx",
    {
      container: "ooxml",
      mediaType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
  ],
  ["ppt", { container: "cfb", mediaType: "application/vnd.ms-powerpoint" }],
  [
    "odt",
    { container: "odf", mediaType: "application/vnd.oasis.opendocument.text" },
  ],
  [
    "ods",
    {
      container: "odf",
      mediaType: "application/vnd.oasis.opendocument.spreadsheet",
    },
  ],
  [
    "odp",
    {
      container: "odf",
      mediaType: "application/vnd.oasis.opendocument.presentation",
    },
  ],
  ["txt", { container: "text", mediaType: "text/plain" }],
  ["md", { container: "text", mediaType: "text/markdown" }],
  ["json", { container: "text", mediaType: "application/json" }],
  ["xml", { container: "text", mediaType: "application/xml" }],
]);

const documentMediaTypes: ReadonlySet<string> = new Set(
  [...documentTypes.values()].map((type) => type.mediaType)
);

/**
 * What a sender may declare next to an allowlisted extension: nothing, the
 * generic binary type, any listed document type (Windows declares a CSV as
 * `application/vnd.ms-excel`), the zip types for a package or any
 * `text/*` type for a text one. Anything else, a video or an executable
 * renamed to `.xlsx`, keeps the file a note.
 */
function declaredFits(
  container: DocumentContainer,
  declared: string | undefined
) {
  if (declared === undefined || declared === "application/octet-stream") {
    return true;
  }
  if (documentMediaTypes.has(declared)) return true;
  if (container === "ooxml" || container === "odf") {
    return (
      declared === "application/zip" ||
      declared === "application/x-zip-compressed"
    );
  }
  return container === "text" && declared.startsWith("text/");
}

function extensionOf(name: string | undefined) {
  const dot = name?.lastIndexOf(".") ?? -1;
  return dot > 0 && name ? name.slice(dot + 1).toLowerCase() : undefined;
}

/**
 * The canonical media type of a document the task agent can open, decided by
 * the file name's extension and checked against the declared type, or
 * `undefined` when the file is not one. It never returns an image or a PDF.
 */
export function documentMediaType(
  name: string | undefined,
  declared: string | undefined
) {
  const type = documentTypes.get(extensionOf(name) ?? "");
  if (type === undefined || !declaredFits(type.container, declared)) {
    return undefined;
  }
  return type.mediaType;
}

const zipSignature = [0x50, 0x4b, 0x03, 0x04] as const;
const cfbSignature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const utf16Boms = [
  [0xff, 0xfe],
  [0xfe, 0xff],
] as const;
/** A text file is believed when this much of its head has no NUL byte. */
const textProbeBytes = 8 * 1024;

function containerOf(mediaType: string) {
  return [...documentTypes.values()].find(
    (entry) => entry.mediaType === mediaType
  )?.container;
}

/**
 * Whether a zip is the package its extension names, not any archive renamed:
 * OOXML lists its parts in `[Content_Types].xml`, whose name the zip's
 * directory holds as is; OpenDocument begins with an uncompressed `mimetype`
 * entry whose content is the document's own media type.
 */
function packageMatches(
  container: "odf" | "ooxml",
  mediaType: string,
  bytes: Uint8Array
) {
  if (!startsWith(bytes, zipSignature)) return false;
  if (container === "ooxml") {
    return Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    ).includes("[Content_Types].xml");
  }
  const nameLength = (bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8);
  const extraLength = (bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8);
  return (
    ascii(bytes, 30, nameLength) === "mimetype" &&
    ascii(bytes, 30 + nameLength + extraLength, mediaType.length) === mediaType
  );
}

function startsWithUtf16Bom(bytes: Uint8Array) {
  return utf16Boms.some((bom) => startsWith(bytes, bom));
}

/**
 * Whether a text document of `mediaType` only looks like audio to the sniff:
 * UTF-16 with a byte order mark, as Excel's "Unicode Text" saves it (the
 * little-endian mark FF FE reads as MPEG frame sync), or text that begins
 * with «ID3» and has no NUL byte, which a real ID3 tag always carries in its
 * version. Such a file's sniff is no verdict: the channels skip it and take
 * the document branch rather than send it to transcription.
 */
export function textDocumentLooksLikeAudio(
  mediaType: string,
  bytes: Uint8Array
) {
  if (containerOf(mediaType) !== "text") return false;
  if (startsWithUtf16Bom(bytes)) return true;
  return (
    isAudioMediaType(sniffMediaType(bytes)) &&
    documentBytesMatch(mediaType, bytes)
  );
}

/**
 * Whether the bytes are what a document of `mediaType` comes in: its own
 * package for OOXML and OpenDocument (`packageMatches`), an OLE compound file for the legacy Office formats,
 * and text without NUL bytes (or with a UTF-16 byte order mark) for the rest.
 * A renamed executable or archive of another kind fails here.
 */
export function documentBytesMatch(mediaType: string, bytes: Uint8Array) {
  const container = containerOf(mediaType);
  switch (container) {
    case "odf":
    case "ooxml": {
      return packageMatches(container, mediaType, bytes);
    }
    case "cfb": {
      return startsWith(bytes, cfbSignature);
    }
    case "text": {
      if (startsWithUtf16Bom(bytes)) return true;
      return !bytes.subarray(0, textProbeBytes).includes(0);
    }
    default: {
      return false;
    }
  }
}

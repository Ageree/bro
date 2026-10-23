/**
 * Checks a downloaded photo for a card and strips what it says beyond the
 * picture (EXIF with the camera and the place it was taken, XMP, IPTC,
 * comments) without decoding it: the container is rewritten, the image data
 * is copied as it came. JPEG, PNG and WebP only, the photos every site and
 * every Telegram client shows; anything else is refused rather than passed on
 * unread. A JPEG keeps its orientation, rewritten as the only EXIF tag, so a
 * phone's portrait shot does not lie on its side.
 */

/** A side shorter than this is a thumbnail or an icon, not a photo to look at. */
const minimumSide = 200;
/** More pixels than this decode into hundreds of megabytes on the phone. */
const maximumPixels = 40_000_000;

type PhotoType = "image/jpeg" | "image/png" | "image/webp";

type Cleaned =
  | {
      readonly kind: "photo";
      readonly bytes: Uint8Array;
      readonly height: number;
      readonly mediaType: PhotoType;
      readonly width: number;
    }
  | {
      readonly kind: "refused";
      readonly reason: "malformed" | "too-large" | "too-small" | "unsupported";
    };

interface Parsed {
  readonly height: number;
  readonly parts: readonly Uint8Array[];
  readonly width: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function byteAt(bytes: Uint8Array, offset: number) {
  return bytes[offset] ?? 0;
}

function uint16(bytes: Uint8Array, offset: number) {
  return (byteAt(bytes, offset) << 8) | byteAt(bytes, offset + 1);
}

function uint32(bytes: Uint8Array, offset: number) {
  return uint16(bytes, offset) * 0x10000 + uint16(bytes, offset + 2);
}

function littleUint16(bytes: Uint8Array, offset: number) {
  return byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8);
}

function littleUint24(bytes: Uint8Array, offset: number) {
  return littleUint16(bytes, offset) | (byteAt(bytes, offset + 2) << 16);
}

function littleUint32(bytes: Uint8Array, offset: number) {
  return littleUint24(bytes, offset) + byteAt(bytes, offset + 3) * 0x1000000;
}

function joined(parts: readonly Uint8Array[]) {
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** Start-of-frame markers; 0xC4, 0xC8 and 0xCC share the range but are not frames. */
function isStartOfFrame(marker: number) {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

/**
 * The application segments a JPEG needs to look as it does: JFIF, the colour
 * profile and Adobe's colour transform. EXIF, XMP, IPTC, the multi-picture
 * index and comments go; every other segment is the image itself.
 */
function keepsSegment(marker: number, data: Uint8Array) {
  if (marker === 0xe0) return ascii(data, 0, 5) === "JFIF\0";
  if (marker === 0xe2) return ascii(data, 0, 12) === "ICC_PROFILE\0";
  if (marker === 0xee) return ascii(data, 0, 5) === "Adobe";
  return marker !== 0xfe && (marker < 0xe0 || marker > 0xef);
}

/** The orientation tag (1–8) of IFD0 in an EXIF block's TIFF data. */
function exifOrientation(tiff: Uint8Array) {
  const order = ascii(tiff, 0, 2);
  if (order !== "II" && order !== "MM") return undefined;
  const read16 = (offset: number) =>
    order === "II" ? littleUint16(tiff, offset) : uint16(tiff, offset);
  const read32 = (offset: number) =>
    order === "II" ? littleUint32(tiff, offset) : uint32(tiff, offset);
  if (tiff.byteLength < 8 || read16(2) !== 42) return undefined;
  const directory = read32(4);
  const entries = read16(directory);
  for (let entry = 0; entry < entries; entry += 1) {
    const offset = directory + 2 + entry * 12;
    if (offset + 12 > tiff.byteLength) return undefined;
    if (read16(offset) === 0x0112 && read16(offset + 2) === 3) {
      const value = read16(offset + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

/** An EXIF segment that says nothing but the orientation. */
function orientationSegment(orientation: number) {
  return new Uint8Array([
    0xff,
    0xe1,
    0x00,
    0x22,
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00,
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
}

/**
 * Where a scan's entropy-coded data ends: at the next marker that is neither
 * a stuffed zero nor a restart.
 */
function scanEnd(bytes: Uint8Array, start: number) {
  let offset = bytes.indexOf(0xff, start);
  while (offset !== -1 && offset + 1 < bytes.byteLength) {
    const next = byteAt(bytes, offset + 1);
    if (next !== 0x00 && next !== 0xff && (next < 0xd0 || next > 0xd7)) {
      return offset;
    }
    offset = bytes.indexOf(0xff, offset + (next === 0xff ? 1 : 2));
  }
  return bytes.byteLength;
}

function parseJpeg(bytes: Uint8Array): Parsed | undefined {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let frame: { height: number; width: number } | undefined;
  let scanned = false;
  let offset = 2;
  while (offset + 1 < bytes.byteLength) {
    if (byteAt(bytes, offset) !== 0xff) return undefined;
    const marker = byteAt(bytes, offset + 1);
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9) {
      parts.push(bytes.subarray(offset, offset + 2));
      return frame && scanned ? { ...frame, parts } : undefined;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    const end = offset + 2 + uint16(bytes, offset + 2);
    if (end <= offset + 3 || end > bytes.byteLength) return undefined;
    const data = bytes.subarray(offset + 4, end);
    if (isStartOfFrame(marker)) {
      frame = { height: uint16(data, 1), width: uint16(data, 3) };
    }
    if (marker === 0xe1 && ascii(data, 0, 6) === "Exif\0\0") {
      const orientation = exifOrientation(data.subarray(6));
      if (orientation !== undefined && orientation !== 1) {
        parts.push(orientationSegment(orientation));
      }
    } else if (keepsSegment(marker, data)) {
      parts.push(bytes.subarray(offset, end));
    }
    offset = end;
    if (marker === 0xda) {
      const next = scanEnd(bytes, offset);
      parts.push(bytes.subarray(offset, next));
      offset = next;
      scanned = true;
    }
  }
  return undefined;
}

/** The chunks that draw a PNG (APNG's too); text, EXIF and time stamps go. */
const pngChunks: ReadonlySet<string> = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "cICP",
  "mDCV",
  "cLLI",
  "bKGD",
  "pHYs",
  "acTL",
  "fcTL",
  "fdAT",
]);

function parsePng(bytes: Uint8Array): Parsed | undefined {
  if (ascii(bytes, 12, 4) !== "IHDR") return undefined;
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + uint32(bytes, offset);
    if (end > bytes.byteLength) return undefined;
    if (pngChunks.has(type)) parts.push(bytes.subarray(offset, end));
    if (type === "IEND") {
      return { height: uint32(bytes, 20), parts, width: uint32(bytes, 16) };
    }
    offset = end;
  }
  return undefined;
}

/** The chunks that draw a WebP; EXIF, XMP and unknown chunks go. */
const webpChunks: ReadonlySet<string> = new Set([
  "VP8X",
  "ICCP",
  "ANIM",
  "ANMF",
  "ALPH",
  "VP8 ",
  "VP8L",
]);
/** The VP8X flags that announce EXIF and XMP chunks. */
const webpMetadataFlags = 0x08 | 0x04;

function webpSize(type: string, data: Uint8Array) {
  if (type === "VP8X") {
    return {
      height: 1 + littleUint24(data, 7),
      width: 1 + littleUint24(data, 4),
    };
  }
  if (type === "VP8 " && ascii(data, 3, 3) === "\x9d\x01\x2a") {
    return {
      height: littleUint16(data, 8) & 0x3fff,
      width: littleUint16(data, 6) & 0x3fff,
    };
  }
  if (type === "VP8L" && byteAt(data, 0) === 0x2f) {
    const bits = littleUint32(data, 1);
    return { height: 1 + ((bits >>> 14) & 0x3fff), width: 1 + (bits & 0x3fff) };
  }
  return undefined;
}

function parseWebp(bytes: Uint8Array): Parsed | undefined {
  const limit = 8 + littleUint32(bytes, 4);
  if (ascii(bytes, 8, 4) !== "WEBP" || limit > bytes.byteLength) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size: { height: number; width: number } | undefined;
  let offset = 12;
  while (offset + 8 <= limit) {
    const type = ascii(bytes, offset, 4);
    const length = littleUint32(bytes, offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (offset + 8 + length > limit) return undefined;
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (chunks.length === 0) size = webpSize(type, data);
    if (type === "VP8X") {
      const header = bytes.slice(offset, Math.min(end, limit));
      header[8] = byteAt(header, 8) & ~webpMetadataFlags;
      chunks.push(header);
    } else if (webpChunks.has(type)) {
      chunks.push(bytes.subarray(offset, Math.min(end, limit)));
    }
    offset = end;
  }
  if (!size) return undefined;
  const body = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const header = new Uint8Array(12);
  header.set(bytes.subarray(0, 4));
  new DataView(header.buffer).setUint32(4, 4 + body, true);
  header.set(bytes.subarray(8, 12), 8);
  return { ...size, parts: [header, ...chunks] };
}

function photoType(bytes: Uint8Array): PhotoType | undefined {
  if (byteAt(bytes, 0) === 0xff && uint16(bytes, 1) === 0xd8ff) {
    return "image/jpeg";
  }
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

const parsers = {
  "image/jpeg": parseJpeg,
  "image/png": parsePng,
  "image/webp": parseWebp,
} as const satisfies Record<
  PhotoType,
  (bytes: Uint8Array) => Parsed | undefined
>;

/**
 * A photo as a card may show it: its type read from the bytes, its size within
 * bounds, and its bytes without metadata. Or why it is not one.
 */
export function cleanPhoto(bytes: Uint8Array): Cleaned {
  const mediaType = photoType(bytes);
  if (!mediaType) return { kind: "refused", reason: "unsupported" };
  const parsed = parsers[mediaType](bytes);
  if (!parsed || parsed.width === 0 || parsed.height === 0) {
    return { kind: "refused", reason: "malformed" };
  }
  if (Math.min(parsed.width, parsed.height) < minimumSide) {
    return { kind: "refused", reason: "too-small" };
  }
  if (parsed.width * parsed.height > maximumPixels) {
    return { kind: "refused", reason: "too-large" };
  }
  return {
    bytes: joined(parsed.parts),
    height: parsed.height,
    kind: "photo",
    mediaType,
    width: parsed.width,
  };
}

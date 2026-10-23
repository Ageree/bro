import { crc32 } from "node:zlib";

/**
 * Small images built byte by byte for the tests of card photos: real
 * containers (JPEG markers, PNG chunks, a RIFF WebP) around placeholder image
 * data, with the metadata a phone or a site leaves in them.
 */

export const gpsText = "GPS 55.7558N 37.6173E";
export const cameraText = "Canon EOS 5D";
export const xmpText = "<x:xmpmeta>Moscow, Tverskaya 4</x:xmpmeta>";

export function ascii(text: string) {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

export function joined(...parts: readonly (Uint8Array | readonly number[])[]) {
  return new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
}

export function contains(bytes: Uint8Array, part: Uint8Array | string) {
  return Buffer.from(bytes).includes(
    part instanceof Uint8Array ? Buffer.from(part) : Buffer.from(part, "latin1")
  );
}

function segment(marker: number, data: Uint8Array) {
  const length = data.byteLength + 2;
  return joined([0xff, marker, length >> 8, length & 0xff], data);
}

/** TIFF data of an EXIF block: IFD0 with the orientation, then text a reader would find. */
export function exifBlock(orientation: number, order: "II" | "MM" = "MM") {
  const short = (value: number) =>
    order === "MM" ? [value >> 8, value & 0xff] : [value & 0xff, value >> 8];
  const long = (value: number) =>
    order === "MM"
      ? [0, 0, value >> 8, value & 0xff]
      : [value & 0xff, value >> 8, 0, 0];
  return joined(
    ascii("Exif\0\0"),
    ascii(order),
    short(42),
    long(8),
    short(1),
    short(0x0112),
    short(3),
    long(1),
    short(orientation),
    [0, 0],
    long(0),
    ascii(`${cameraText} ${gpsText}`)
  );
}

/** Entropy-coded bytes with a stuffed 0xFF and a restart marker in them. */
export const scanData = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];

export function jpeg({
  height,
  orientation,
  tail = [0xff, 0xd9],
  width,
}: {
  readonly height: number;
  readonly orientation?: number;
  readonly tail?: readonly number[];
  readonly width: number;
}) {
  return joined(
    [0xff, 0xd8],
    segment(0xe0, ascii("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    orientation === undefined ? [] : segment(0xe1, exifBlock(orientation)),
    segment(0xe1, ascii(`http://ns.adobe.com/xap/1.0/\0${xmpText}`)),
    segment(0xe2, ascii("ICC_PROFILE\0\x01\x01profile")),
    segment(0xed, ascii(`Photoshop 3.0\0${gpsText}`)),
    segment(0xee, ascii("Adobe\0d\0\0\0\0\x01")),
    segment(0xfe, ascii(cameraText)),
    segment(0xdb, new Uint8Array(65)),
    segment(
      0xc0,
      new Uint8Array([
        8,
        height >> 8,
        height & 0xff,
        width >> 8,
        width & 0xff,
        1,
        1,
        0x11,
        0,
      ])
    ),
    segment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])),
    scanData,
    tail
  );
}

function chunk(type: string, data: Uint8Array) {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, data.byteLength);
  const named = joined(ascii(type), data);
  const check = new Uint8Array(4);
  new DataView(check.buffer).setUint32(0, crc32(named));
  return joined(length, named, check);
}

export function png({
  end = true,
  height,
  width,
}: {
  readonly end?: boolean;
  readonly height: number;
  readonly width: number;
}) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  return joined(
    ascii("\x89PNG\r\n\x1a\n"),
    chunk("IHDR", header),
    chunk("iCCP", ascii("profile\0\0data")),
    chunk("tEXt", ascii(`Comment\0${cameraText}`)),
    chunk("eXIf", ascii(gpsText)),
    chunk("iTXt", ascii(`XML:com.adobe.xmp\0\0\0\0\0${xmpText}`)),
    chunk("tIME", new Uint8Array(7)),
    chunk("pHYs", new Uint8Array(9)),
    chunk("IDAT", new Uint8Array([1, 2, 3, 4])),
    end ? chunk("IEND", new Uint8Array()) : [],
    ascii("TRAILING")
  );
}

function riffChunk(type: string, data: Uint8Array) {
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, data.byteLength, true);
  return joined(ascii(type), size, data, data.byteLength % 2 === 1 ? [0] : []);
}

export function webp({
  height,
  riffSlack = 0,
  width,
}: {
  readonly height: number;
  readonly riffSlack?: number;
  readonly width: number;
}) {
  const canvas = new Uint8Array(10);
  canvas[0] = 0x20 | 0x08 | 0x04;
  canvas.set(
    [
      (width - 1) & 0xff,
      (width - 1) >> 8,
      0,
      (height - 1) & 0xff,
      (height - 1) >> 8,
      0,
    ],
    4
  );
  const frame = new Uint8Array(10);
  frame.set([
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
  ]);
  const body = joined(
    ascii("WEBP"),
    riffChunk("VP8X", canvas),
    riffChunk("ICCP", ascii("profile")),
    riffChunk("VP8 ", frame),
    riffChunk("EXIF", ascii(gpsText)),
    riffChunk("XMP ", ascii(xmpText))
  );
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, body.byteLength + riffSlack, true);
  return joined(ascii("RIFF"), size, body);
}

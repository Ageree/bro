/**
 * A transparent PNG laid on white. Telegram turns a photo into a JPEG, which
 * has no transparency, and the colour a PNG keeps under its transparent
 * pixels is often black: a shop's cut-out product (every Lavka photo, 20.10)
 * would arrive as a dark blot on black. Only the common PNG is redrawn — 8
 * bits a channel, grey or RGB with alpha, not interlaced; any other comes
 * back `undefined` and goes as it is.
 */

import { promisify } from "node:util";
import { crc32, deflate, inflate } from "node:zlib";

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
/** Grey with alpha and RGB with alpha, and what each becomes without it. */
const withAlpha = new Map([
  [4, { channels: 2, opaque: 0 }],
  [6, { channels: 4, opaque: 2 }],
]);
/**
 * A redrawn photo holds its pixels about three times over (inflated, undone,
 * on white), and its work holds up the event loop: a 6 Mpx one took 0.4 s of
 * it. A shop's photo is far smaller (Lavka's, 0.36 Mpx: 70 ms), and Telegram
 * shrinks a photo to 2560 px on the long side anyway.
 */
const maximumPixels = 4_000_000;

export async function flattenedPng(png: Buffer) {
  const image = readPng(png);
  if (!image) return undefined;
  const { channels, height, opaque, width } = image;
  const rowBytes = width * channels;
  let pixels: Buffer;
  try {
    pixels = await inflateAsync(image.data, {
      maxOutputLength: height * (rowBytes + 1),
    });
  } catch {
    return undefined;
  }
  if (pixels.byteLength !== height * (rowBytes + 1)) return undefined;
  const rows = unfiltered(pixels, rowBytes, channels);
  if (!rows || !transparent(rows, channels)) return undefined;
  const colours = channels - 1;
  // Each row under the Sub filter: unfiltered, a 2449 px photo came out
  // past Telegram's 10 MB and went with its black background after all.
  const flat = Buffer.alloc(height * (width * colours + 1));
  const left = Buffer.alloc(colours);
  for (let y = 0; y < height; y += 1) {
    const from = y * rowBytes;
    const to = y * (width * colours + 1);
    flat[to] = 1;
    left.fill(0);
    for (let x = 0; x < width; x += 1) {
      const pixel = from + x * channels;
      const alpha = rows[pixel + colours] ?? 255;
      for (let colour = 0; colour < colours; colour += 1) {
        const value = Math.round(
          ((rows[pixel + colour] ?? 0) * alpha + 255 * (255 - alpha)) / 255
        );
        flat[to + 1 + x * colours + colour] =
          (value - (left[colour] ?? 0)) & 0xff;
        left[colour] = value;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque;
  return Buffer.concat([
    pngSignature,
    chunk("IHDR", header),
    chunk("IDAT", await deflateAsync(flat)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The header and the joined image data of a PNG this module redraws. */
function readPng(png: Buffer) {
  if (png.byteLength < 33 || !png.subarray(0, 8).equals(pngSignature)) {
    return undefined;
  }
  const data: Buffer[] = [];
  let header: Buffer | undefined;
  for (let at = 8; at + 12 <= png.byteLength;) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (body.byteLength !== length) return undefined;
    if (type === "IHDR") header = body;
    if (type === "IDAT") data.push(body);
    if (type === "IEND") break;
    at += length + 12;
  }
  if (header?.byteLength !== 13 || data.length === 0) return undefined;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const kind = withAlpha.get(header[9] ?? 0);
  // Bit depth 8, deflate, adaptive filtering, no interlace.
  const plain =
    header[8] === 8 && header[10] === 0 && header[11] === 0 && header[12] === 0;
  if (
    !kind ||
    !plain ||
    width * height > maximumPixels ||
    width * height === 0
  ) {
    return undefined;
  }
  return { ...kind, data: Buffer.concat(data), height, width };
}

/** The scanlines without their filter bytes, each filter undone. */
function unfiltered(pixels: Buffer, rowBytes: number, step: number) {
  const height = pixels.byteLength / (rowBytes + 1);
  const rows = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = pixels[y * (rowBytes + 1)];
    const source = y * (rowBytes + 1) + 1;
    const row = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= step ? (rows[row + x - step] ?? 0) : 0;
      const up = y > 0 ? (rows[row - rowBytes + x] ?? 0) : 0;
      const corner =
        x >= step && y > 0 ? (rows[row - rowBytes + x - step] ?? 0) : 0;
      const predicted = predict(filter, left, up, corner);
      if (predicted === undefined) return undefined;
      rows[row + x] = ((pixels[source + x] ?? 0) + predicted) & 0xff;
    }
  }
  return rows;
}

/** Whether any pixel lets the background through: one wholly opaque is sent as it is. */
function transparent(rows: Buffer, channels: number) {
  for (let alpha = channels - 1; alpha < rows.byteLength; alpha += channels) {
    if ((rows[alpha] ?? 255) < 255) return true;
  }
  return false;
}

function predict(
  filter: number | undefined,
  left: number,
  up: number,
  corner: number
) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter !== 4) return undefined;
  const estimate = left + up - corner;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toCorner = Math.abs(estimate - corner);
  if (toLeft <= toUp && toLeft <= toCorner) return left;
  return toUp <= toCorner ? up : corner;
}

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.byteLength, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

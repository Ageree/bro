/**
 * Hand-built PNG files for the photo tests: 8 bits a channel, each scanline
 * under the filter the test names, so a reader has to undo every filter type.
 */

import { crc32, deflateSync, inflateSync } from "node:zlib";

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const channelsOf = new Map([
  [0, 1],
  [2, 3],
  [4, 2],
  [6, 4],
]);

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.byteLength, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

function paeth(left: number, up: number, corner: number) {
  const estimate = left + up - corner;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toCorner = Math.abs(estimate - corner);
  if (toLeft <= toUp && toLeft <= toCorner) return left;
  return toUp <= toCorner ? up : corner;
}

/** A PNG of these scanlines; row `y` goes under `filters[y]` (0 when absent). */
export function syntheticPng({
  colorType,
  filters = [],
  rows,
}: {
  readonly colorType: 0 | 2 | 4 | 6;
  readonly filters?: readonly number[];
  readonly rows: readonly (readonly number[])[];
}) {
  const channels = channelsOf.get(colorType) ?? 1;
  const width = (rows[0]?.length ?? 0) / channels;
  const lines = rows.map((row, y) => {
    const filter = filters[y] ?? 0;
    const above = rows[y - 1];
    const encoded = row.map((value, x) => {
      const left = x >= channels ? (row[x - channels] ?? 0) : 0;
      const up = above?.[x] ?? 0;
      const corner = x >= channels ? (above?.[x - channels] ?? 0) : 0;
      const predicted = [
        0,
        left,
        up,
        Math.floor((left + up) / 2),
        paeth(left, up, corner),
      ][filter];
      return (value - (predicted ?? 0)) & 0xff;
    });
    return Buffer.from([filter, ...encoded]);
  });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(rows.length, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(lines))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The colour type and scanlines of a PNG whose rows are unfiltered or under
 * the Sub filter, as `flattenedPng` writes them.
 */
export function readPngRows(png: Uint8Array) {
  const bytes = Buffer.from(png);
  const colorType = bytes[25] ?? 0;
  const width = bytes.readUInt32BE(16);
  const channels = channelsOf.get(colorType) ?? 1;
  const data: Buffer[] = [];
  for (let at = 8; at + 12 <= bytes.byteLength;) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString("latin1", at + 4, at + 8) === "IDAT") {
      data.push(bytes.subarray(at + 8, at + 8 + length));
    }
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels + 1;
  const rows = Array.from({ length: raw.byteLength / stride }, (_, y) => {
    const filter = raw[y * stride];
    if (filter !== 0 && filter !== 1)
      throw new Error(`filter ${String(filter)}`);
    const row = [...raw.subarray(y * stride + 1, (y + 1) * stride)];
    if (filter === 1) {
      for (let x = channels; x < row.length; x += 1) {
        row[x] = ((row[x] ?? 0) + (row[x - channels] ?? 0)) & 0xff;
      }
    }
    return row;
  });
  return { colorType, rows };
}

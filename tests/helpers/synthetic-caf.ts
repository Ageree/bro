/**
 * Hand-built Apple Core Audio Format files for the voice-note tests: one Opus
 * packet the way iMessage records it, and an LPCM file the remuxer must refuse.
 */

function be32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, false);
  return bytes;
}

function be64(value: number) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value), false);
  return bytes;
}

function f64(value: number) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return bytes;
}

function concat(...parts: readonly Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function ascii(text: string) {
  return new TextEncoder().encode(text);
}

/** A packet-table size the way the remuxer reads it: big-endian 7-bit groups, continuation in the high bit. */
function vlq(value: number) {
  const groups = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    groups.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return new Uint8Array(groups);
}

function chunk(type: string, data: Uint8Array) {
  return concat(ascii(type), be64(data.length), data);
}

const header = concat(ascii("caff"), new Uint8Array([0, 1, 0, 0]));

/** The single Opus packet every synthetic file carries by default. */
export const syntheticOpusPacket = new Uint8Array([0xfc, 0xff, 0xfe]);

/** How a synthetic CAF Opus file departs from the one-packet default. */
export interface SyntheticCafOpusOptions {
  /** `mBytesPerPacket` in the description; zero means variable packet sizes. */
  readonly bytesPerPacket?: number;
  /** The Opus packets, back to back in the data chunk. */
  readonly packets?: readonly Uint8Array[];
  /** The packet table's priming and remainder frames, or no `pakt` chunk. */
  readonly packetTable?:
    | false
    | { readonly priming: number; readonly remainder: number };
}

/** A CAF Opus file: 48 kHz, mono, 960 frames per packet. */
export function syntheticCafOpus(options: SyntheticCafOpusOptions = {}) {
  const bytesPerPacket = options.bytesPerPacket ?? 0;
  const packets = options.packets ?? [syntheticOpusPacket];
  const packetTable = options.packetTable ?? { priming: 312, remainder: 0 };
  const desc = concat(
    f64(48_000),
    ascii("opus"),
    be32(0),
    be32(bytesPerPacket),
    be32(960),
    be32(1),
    be32(0)
  );
  const data = concat(be32(0), ...packets);
  if (packetTable === false) {
    return concat(header, chunk("desc", desc), chunk("data", data));
  }
  const pakt = concat(
    be64(packets.length),
    be64(960 * packets.length - packetTable.priming - packetTable.remainder),
    be32(packetTable.priming),
    be32(packetTable.remainder),
    ...(bytesPerPacket === 0 ? packets.map((packet) => vlq(packet.length)) : [])
  );
  return concat(
    header,
    chunk("desc", desc),
    chunk("pakt", pakt),
    chunk("data", data)
  );
}

/** A CAF file with raw PCM audio, which no transcription provider takes. */
export function syntheticCafLpcm() {
  const desc = concat(
    f64(48_000),
    ascii("lpcm"),
    be32(0),
    be32(2),
    be32(1),
    be32(1),
    be32(16)
  );
  return concat(
    header,
    chunk("desc", desc),
    chunk("data", concat(be32(0), new Uint8Array(4)))
  );
}

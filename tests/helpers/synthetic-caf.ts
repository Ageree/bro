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

function chunk(type: string, data: Uint8Array) {
  return concat(ascii(type), be64(data.length), data);
}

const header = concat(ascii("caff"), new Uint8Array([0, 1, 0, 0]));

/** The single Opus packet every synthetic file carries. */
export const syntheticOpusPacket = new Uint8Array([0xfc, 0xff, 0xfe]);

/** A one-packet CAF Opus file: 48 kHz, mono, 960 frames per packet. */
export function syntheticCafOpus() {
  const desc = concat(
    f64(48_000),
    ascii("opus"),
    be32(0),
    be32(0),
    be32(960),
    be32(1),
    be32(0)
  );
  const pakt = concat(
    be64(1),
    be64(960),
    be32(312),
    be32(0),
    new Uint8Array([syntheticOpusPacket.length])
  );
  const data = concat(be32(0), syntheticOpusPacket);
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

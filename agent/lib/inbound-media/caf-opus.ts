/**
 * Apple Core Audio Format (CAF) with an Opus payload, remuxed to Ogg Opus in
 * pure TypeScript. iMessage voice notes arrive this way and no transcription
 * provider accepts CAF, while every one of them takes Ogg.
 */

const cafMagic = 0x63616666; // "caff"
const oggCrcPolynomial = 0x04c11db7;
const defaultPreSkip = 312;
const opusRate = 48_000;
/** More packets than any voice note holds; a larger count is a corrupt table. */
const maxPacketCount = 1_000_000;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 0x80000000) === 0
          ? value << 1
          : (value << 1) ^ oggCrcPolynomial;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function viewOf(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function fourcc(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function u32be(bytes: Uint8Array, offset: number) {
  return viewOf(bytes).getUint32(offset, false);
}

function i32be(bytes: Uint8Array, offset: number) {
  return viewOf(bytes).getInt32(offset, false);
}

function i64be(bytes: Uint8Array, offset: number) {
  const value = viewOf(bytes).getBigInt64(offset, false);
  if (value < -1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("caf int64 out of range");
  }
  return Number(value);
}

function f64be(bytes: Uint8Array, offset: number) {
  return viewOf(bytes).getFloat64(offset, false);
}

export function isCaf(bytes: Uint8Array) {
  return bytes.length >= 8 && u32be(bytes, 0) === cafMagic;
}

interface CafChunk {
  readonly data: Uint8Array;
  readonly type: string;
}

function parseChunks(bytes: Uint8Array) {
  if (!isCaf(bytes)) throw new Error("not caf");
  const chunks: CafChunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const type = fourcc(bytes, offset);
    let size = i64be(bytes, offset + 4);
    const start = offset + 12;
    if (size === -1) size = bytes.length - start;
    if (size < 0 || start + size > bytes.length) {
      throw new Error("caf chunk truncated");
    }
    chunks.push({ data: bytes.subarray(start, start + size), type });
    offset = start + size;
  }
  return chunks;
}

function chunkOf(chunks: readonly CafChunk[], type: string) {
  return chunks.find((chunk) => chunk.type === type)?.data;
}

function formatIdOf(desc: Uint8Array) {
  return fourcc(desc, 8).replaceAll("\0", "").trim().toLowerCase();
}

/** The four-character codec id from the `desc` chunk, or nothing for a broken file. */
export function cafCodec(bytes: Uint8Array) {
  if (!isCaf(bytes)) return undefined;
  let desc: Uint8Array | undefined;
  try {
    desc = chunkOf(parseChunks(bytes), "desc");
  } catch {
    return undefined;
  }
  if (!desc || desc.length < 32) return undefined;
  return formatIdOf(desc);
}

/** CAF packet sizes are MIDI-style 7-bit VLQs, continuation in the high bit. */
function readVlq(bytes: Uint8Array, offset: number) {
  let value = 0;
  let index = offset;
  for (let count = 0; count < 8; count += 1) {
    const byte = bytes[index];
    if (byte === undefined) throw new Error("caf vlq truncated");
    index += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { next: index, value };
  }
  throw new Error("caf vlq too long");
}

/**
 * The packet boundaries: from the packet table, or for a constant-size stream
 * without one, by cutting the payload into `mBytesPerPacket` slices.
 */
function packetSizes(
  desc: Uint8Array,
  pakt: Uint8Array | undefined,
  payloadLength: number
) {
  const bytesPerPacket = u32be(desc, 16);
  if (!pakt || pakt.length < 24) {
    if (bytesPerPacket === 0) throw new Error("caf missing pakt");
    if (payloadLength % bytesPerPacket !== 0) {
      throw new Error("caf packet remainder");
    }
    const sliceCount = payloadLength / bytesPerPacket;
    if (sliceCount > maxPacketCount) throw new Error("caf packet count");
    return Array.from({ length: sliceCount }, () => bytesPerPacket);
  }
  const numberPackets = i64be(pakt, 0);
  if (numberPackets < 0 || numberPackets > maxPacketCount) {
    throw new Error("caf packet count");
  }
  if (bytesPerPacket > 0) {
    return Array.from({ length: numberPackets }, () => bytesPerPacket);
  }
  const sizes: number[] = [];
  let offset = 24;
  for (let count = 0; count < numberPackets; count += 1) {
    const read = readVlq(pakt, offset);
    sizes.push(read.value);
    offset = read.next;
  }
  return sizes;
}

function splitPackets(payload: Uint8Array, sizes: readonly number[]) {
  const packets: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (size < 0 || offset + size > payload.length) {
      throw new Error("caf packet overrun");
    }
    packets.push(payload.subarray(offset, offset + size));
    offset += size;
  }
  return packets;
}

const frameMillisecondsByConfig = [
  10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 10, 20, 2.5, 5, 10,
  20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20,
];

/** RFC 6716 §3.1: duration of one Opus packet in 48 kHz samples. */
function opusPacketSamples(packet: Uint8Array) {
  const toc = packet[0];
  if (toc === undefined) return 960;
  const config = toc >> 3;
  const code = toc & 3;
  const frameMilliseconds = frameMillisecondsByConfig[config] ?? 20;
  const frameSamples = (frameMilliseconds * opusRate) / 1000;
  if (code === 0) return frameSamples;
  if (code === 1 || code === 2) return frameSamples * 2;
  // RFC 6716 §3.2.5 frame count byte, MSB first: VBR flag, padding flag, then
  // the six-bit frame count, which is why the count is the low six bits.
  const frameCount = (packet[1] ?? 0) & 0x3f;
  return frameSamples * (frameCount === 0 ? 1 : frameCount);
}

function oggCrc32(page: Uint8Array) {
  let crc = 0;
  for (const byte of page) {
    crc = ((crc << 8) ^ (crcTable[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
  }
  return crc;
}

interface OggPage {
  readonly granule: bigint;
  readonly headerType: number;
  readonly packets: readonly Uint8Array[];
  readonly sequence: number;
  readonly serial: number;
}

function writePage(page: OggPage) {
  const lacing: number[] = [];
  let bodyLength = 0;
  for (const packet of page.packets) {
    bodyLength += packet.length;
    if (packet.length === 0) {
      lacing.push(0);
      continue;
    }
    let remaining = packet.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
  }
  if (lacing.length > 255) throw new Error("ogg page too many segments");
  const bytes = new Uint8Array(27 + lacing.length + bodyLength);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4f, 0x67, 0x67, 0x53]); // OggS
  bytes[4] = 0;
  bytes[5] = page.headerType;
  view.setBigInt64(6, page.granule, true);
  view.setUint32(14, page.serial >>> 0, true);
  view.setUint32(18, page.sequence >>> 0, true);
  view.setUint32(22, 0, true);
  bytes[26] = lacing.length;
  bytes.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const packet of page.packets) {
    bytes.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggCrc32(bytes), true);
  return bytes;
}

function concat(parts: readonly Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function opusHead(channels: number, preSkip: number, inputRate: number) {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // OpusHead
  head[8] = 1;
  head[9] = Math.max(1, Math.min(255, channels));
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate >>> 0, true);
  view.setInt16(16, 0, true);
  head[18] = 0;
  return head;
}

function opusTags() {
  const vendor = new TextEncoder().encode("Bro");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // OpusTags
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true);
  return tags;
}

/**
 * Wraps the Opus packets of a CAF file into an Ogg Opus stream. Throws
 * `unsupported_caf_codec` for any other payload and on a truncated file.
 */
export function cafOpusToOgg(bytes: Uint8Array) {
  const chunks = parseChunks(bytes);
  const desc = chunkOf(chunks, "desc");
  if (!desc || desc.length < 32) throw new Error("caf missing desc");
  if (formatIdOf(desc) !== "opus") throw new Error("unsupported_caf_codec");
  const channels = u32be(desc, 24) || 1;
  const sampleRate = Math.round(f64be(desc, 0)) || opusRate;
  const pakt = chunkOf(chunks, "pakt");
  // The packet table records the encoder's priming and trailing padding. A
  // recorded zero is kept as is; only a missing table falls back to the
  // pre-skip Apple's Opus encoder uses.
  const preSkip =
    pakt && pakt.length >= 24
      ? Math.max(0, Math.min(0xffff, i32be(pakt, 16)))
      : defaultPreSkip;
  const remainderFrames =
    pakt && pakt.length >= 24 ? Math.max(0, i32be(pakt, 20)) : 0;
  const data = chunkOf(chunks, "data");
  if (!data || data.length < 4) throw new Error("caf missing data");
  // The data chunk starts with a four-byte edit count; packets follow back to back.
  const payload = data.subarray(4);
  const packets = splitPackets(
    payload,
    packetSizes(desc, pakt, payload.length)
  );
  if (packets.length === 0) throw new Error("caf empty audio");
  const serial = 1;
  const pages = [
    writePage({
      granule: 0n,
      headerType: 0x02,
      packets: [opusHead(channels, preSkip, sampleRate)],
      sequence: 0,
      serial,
    }),
    writePage({
      granule: 0n,
      headerType: 0,
      packets: [opusTags()],
      sequence: 1,
      serial,
    }),
  ];
  let granule = 0;
  for (const [index, packet] of packets.entries()) {
    granule += opusPacketSamples(packet);
    const last = index === packets.length - 1;
    // The final granule ends the stream before the encoder's trailing padding,
    // so a decoder does not play the remainder frames as silence.
    const pageGranule = last ? Math.max(0, granule - remainderFrames) : granule;
    pages.push(
      writePage({
        granule: BigInt(pageGranule),
        headerType: last ? 0x04 : 0,
        packets: [packet],
        sequence: index + 2,
        serial,
      })
    );
  }
  return concat(pages);
}

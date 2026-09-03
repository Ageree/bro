/** CAF (Apple Core Audio Format) Opus → Ogg Opus, pure TypeScript. */

const CAF_MAGIC = 0x63616666; // 'caff'
const OGG_CRC_POLY = 0x04c11db7;
const DEFAULT_PRE_SKIP = 312;
const OPUS_RATE = 48_000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) !== 0 ? (r << 1) ^ OGG_CRC_POLY : r << 1;
    }
    t[i] = r >>> 0;
  }
  return t;
})();

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function u32be(bytes: Uint8Array, offset: number): number {
  return viewOf(bytes).getUint32(offset, false);
}

function i32be(bytes: Uint8Array, offset: number): number {
  return viewOf(bytes).getInt32(offset, false);
}

function i64be(bytes: Uint8Array, offset: number): number {
  const n = viewOf(bytes).getBigInt64(offset, false);
  if (n < -1n || n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("caf int64 out of range");
  }
  return Number(n);
}

function f64be(bytes: Uint8Array, offset: number): number {
  return viewOf(bytes).getFloat64(offset, false);
}

export function isCaf(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && u32be(bytes, 0) === CAF_MAGIC;
}

type CafChunk = { type: string; data: Uint8Array };

function parseChunks(bytes: Uint8Array): CafChunk[] {
  if (!isCaf(bytes)) throw new Error("not caf");
  const chunks: CafChunk[] = [];
  let off = 8;
  while (off + 12 <= bytes.length) {
    const type = fourcc(bytes, off);
    let size = i64be(bytes, off + 4);
    const start = off + 12;
    if (size === -1) size = bytes.length - start;
    if (size < 0 || start + size > bytes.length) {
      throw new Error("caf chunk truncated");
    }
    chunks.push({ type, data: bytes.subarray(start, start + size) });
    off = start + size;
  }
  return chunks;
}

function chunk(chunks: CafChunk[], type: string): Uint8Array | undefined {
  return chunks.find((c) => c.type === type)?.data;
}

export function cafCodec(bytes: Uint8Array): string | null {
  if (!isCaf(bytes)) return null;
  let desc: Uint8Array | undefined;
  try {
    desc = chunk(parseChunks(bytes), "desc");
  } catch {
    return null;
  }
  if (!desc || desc.length < 32) return null;
  return fourcc(desc, 8).replace(/\0/g, "").trim().toLowerCase();
}

/** CAF packet sizes are MIDI-style 7-bit VLQs, continuation in the high bit. */
function readVlq(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let i = offset;
  for (let n = 0; n < 8; n++) {
    if (i >= bytes.length) throw new Error("caf vlq truncated");
    const b = bytes[i]!;
    i++;
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return { value, next: i };
  }
  throw new Error("caf vlq too long");
}

function packetSizes(desc: Uint8Array, pakt: Uint8Array | undefined): number[] {
  const bytesPerPacket = u32be(desc, 16);
  if (!pakt || pakt.length < 24) {
    if (bytesPerPacket > 0) return [];
    throw new Error("caf missing pakt");
  }
  const numberPackets = i64be(pakt, 0);
  if (numberPackets < 0 || numberPackets > 1_000_000) {
    throw new Error("caf packet count");
  }
  if (bytesPerPacket > 0) {
    return Array.from({ length: numberPackets }, () => bytesPerPacket);
  }
  const sizes: number[] = [];
  let i = 24;
  for (let n = 0; n < numberPackets; n++) {
    const got = readVlq(pakt, i);
    sizes.push(got.value);
    i = got.next;
  }
  return sizes;
}

function splitPackets(payload: Uint8Array, sizes: number[]): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let off = 0;
  for (const size of sizes) {
    if (size < 0 || off + size > payload.length) throw new Error("caf packet overrun");
    packets.push(payload.subarray(off, off + size));
    off += size;
  }
  return packets;
}

/** RFC 6716 §3.1: duration of one Opus packet in 48 kHz samples. */
function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length < 1) return 960;
  const toc = packet[0]!;
  const config = toc >> 3;
  const code = toc & 3;
  const frameMs = [
    10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 10, 20, 2.5, 5, 10,
    20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20,
  ][config] ?? 20;
  const frameSamples = (frameMs * OPUS_RATE) / 1000;
  if (code === 0) return frameSamples;
  if (code === 1 || code === 2) return frameSamples * 2;
  if (packet.length < 2) return frameSamples;
  const m = packet[1]! & 0x3f;
  return frameSamples * (m === 0 ? 1 : m);
}

function oggCrc32(page: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ page[i]!) & 0xff]!) >>> 0;
  }
  return crc;
}

function writePage(opts: {
  headerType: number;
  granule: bigint;
  serial: number;
  seq: number;
  packets: Uint8Array[];
}): Uint8Array {
  const lacing: number[] = [];
  let bodyLen = 0;
  for (const pkt of opts.packets) {
    bodyLen += pkt.length;
    if (pkt.length === 0) {
      lacing.push(0);
      continue;
    }
    let remaining = pkt.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
  }
  if (lacing.length > 255) throw new Error("ogg page too many segments");
  const page = new Uint8Array(27 + lacing.length + bodyLen);
  const view = new DataView(page.buffer);
  page[0] = 0x4f;
  page[1] = 0x67;
  page[2] = 0x67;
  page[3] = 0x53;
  page[4] = 0;
  page[5] = opts.headerType;
  view.setBigInt64(6, opts.granule, true);
  view.setUint32(14, opts.serial >>> 0, true);
  view.setUint32(18, opts.seq >>> 0, true);
  view.setUint32(22, 0, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let off = 27 + lacing.length;
  for (const pkt of opts.packets) {
    page.set(pkt, off);
    off += pkt.length;
  }
  view.setUint32(22, oggCrc32(page), true);
  return page;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function opusHead(channels: number, preSkip: number, inputRate: number): Uint8Array {
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

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("Bro");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // OpusTags
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true);
  return tags;
}

export function cafOpusToOgg(bytes: Uint8Array): Uint8Array {
  const chunks = parseChunks(bytes);
  const desc = chunk(chunks, "desc");
  if (!desc || desc.length < 32) throw new Error("caf missing desc");
  const formatId = fourcc(desc, 8).replace(/\0/g, "").trim().toLowerCase();
  if (formatId !== "opus") throw new Error("unsupported_caf_codec");
  const channels = u32be(desc, 24) || 1;
  const sampleRate = Math.round(f64be(desc, 0)) || OPUS_RATE;
  const pakt = chunk(chunks, "pakt");
  const priming = pakt && pakt.length >= 24 ? i32be(pakt, 16) : 0;
  const preSkip = priming > 0 ? priming : DEFAULT_PRE_SKIP;
  const data = chunk(chunks, "data");
  if (!data || data.length < 4) throw new Error("caf missing data");
  // data chunk: 4-byte edit count, then packets back-to-back
  const payload = data.subarray(4);
  const sizes = packetSizes(desc, pakt);
  if (sizes.length === 0) {
    if (payload.length === 0) throw new Error("caf empty audio");
    sizes.push(payload.length);
  }
  const packets = splitPackets(payload, sizes);
  const serial = 1;
  const pages: Uint8Array[] = [
    writePage({
      headerType: 0x02,
      granule: 0n,
      serial,
      seq: 0,
      packets: [opusHead(channels, preSkip, sampleRate)],
    }),
    writePage({
      headerType: 0,
      granule: 0n,
      serial,
      seq: 1,
      packets: [opusTags()],
    }),
  ];
  let granule = 0;
  for (let i = 0; i < packets.length; i++) {
    const pkt = packets[i]!;
    granule += opusPacketSamples(pkt);
    const last = i === packets.length - 1;
    pages.push(
      writePage({
        headerType: last ? 0x04 : 0,
        granule: BigInt(granule),
        serial,
        seq: i + 2,
        packets: [pkt],
      }),
    );
  }
  return concat(pages);
}

// G.711 (ITU-T, the reference g711.c): telephony carries 8 kHz A-law or μ-law, and GPT-Live takes A-law
// as is, so only a μ-law leg is transcoded. Linear values are signed 16-bit.

export type Law = "pcma" | "pcmu";

const alawSegments = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
const ulawSegments = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];

function segment(value: number, ends: readonly number[]) {
  const found = ends.findIndex((end) => value <= end);
  return found === -1 ? ends.length : found;
}

export function alawToLinear(byte: number) {
  const value = byte ^ 0x55;
  const level = (value & 0x70) >> 4;
  let linear = (value & 0x0f) << 4;
  if (level === 0) linear += 8;
  else if (level === 1) linear += 0x108;
  else linear = (linear + 0x108) << (level - 1);
  return value & 0x80 ? linear : -linear;
}

export function linearToAlaw(sample: number) {
  let value = sample >> 3;
  let mask = 0xd5;
  if (value < 0) {
    mask = 0x55;
    value = -value - 1;
  }
  const level = segment(value, alawSegments);
  if (level >= 8) return 0x7f ^ mask;
  const step = level < 2 ? (value >> 1) & 0x0f : (value >> level) & 0x0f;
  return ((level << 4) | step) ^ mask;
}

export function ulawToLinear(byte: number) {
  const value = ~byte & 0xff;
  const linear = (((value & 0x0f) << 3) + 0x84) << ((value & 0x70) >> 4);
  return value & 0x80 ? 0x84 - linear : linear - 0x84;
}

export function linearToUlaw(sample: number) {
  let value = sample >> 2;
  let mask = 0xff;
  if (value < 0) {
    value = -value;
    mask = 0x7f;
  }
  value = Math.min(value, 8159) + (0x84 >> 2);
  const level = segment(value, ulawSegments);
  if (level >= 8) return 0x7f ^ mask;
  return ((level << 4) | ((value >> (level + 1)) & 0x0f)) ^ mask;
}

export function toLinear(payload: Uint8Array, law: Law) {
  const decode = law === "pcma" ? alawToLinear : ulawToLinear;
  return Int16Array.from(payload, decode);
}

/** One leg's bytes in the other law: the carrier's μ-law to GPT-Live's A-law and back. */
export function transcode(payload: Uint8Array, from: Law, to: Law) {
  if (from === to) return payload;
  const encode = to === "pcma" ? linearToAlaw : linearToUlaw;
  return Uint8Array.from(toLinear(payload, from), encode);
}

/** The byte a silent frame repeats: a zero sample in each law. */
export function silenceByte(law: Law) {
  return law === "pcma" ? 0xd5 : 0xff;
}

export function rms(samples: Int16Array) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

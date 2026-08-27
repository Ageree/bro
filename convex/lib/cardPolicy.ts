export type CardBrand = "mir" | "visa" | "mc";

export function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

export function luhnOk(pan: string): boolean {
  const d = digitsOnly(pan);
  if (d.length < 12) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function cardBrand(pan: string): CardBrand | null {
  const d = digitsOnly(pan);
  if (d.length < 4) return null;
  const n4 = Number(d.slice(0, 4));
  if (n4 >= 2200 && n4 <= 2204) return "mir";
  if (d[0] === "4") return "visa";
  const n2 = Number(d.slice(0, 2));
  if (n2 >= 51 && n2 <= 55) return "mc";
  if (n4 >= 2221 && n4 <= 2720) return "mc";
  return null;
}

function normalizeYear(year: number): number {
  return year >= 0 && year <= 99 ? 2000 + year : year;
}

export function expiryOk(month: number, year: number, now: Date = new Date()): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(year)) return false;
  const y = normalizeYear(year);
  const nowY = now.getFullYear();
  const nowM = now.getMonth() + 1;
  return y > nowY || (y === nowY && month >= nowM);
}

export function cvcOk(cvc: string): boolean {
  return /^\d{3,4}$/.test(cvc);
}

export function parseCardInput(input: {
  pan: string;
  expMonth: number;
  expYear: number;
  cvc: string;
}):
  | { ok: true; pan: string; expMonth: number; expYear: number; cvc: string; brand: CardBrand; last4: string }
  | { ok: false; error: string } {
  const pan = digitsOnly(input.pan);
  if (pan.length < 13 || pan.length > 19) return { ok: false, error: "pan" };
  if (!luhnOk(pan)) return { ok: false, error: "luhn" };
  const brand = cardBrand(pan);
  if (!brand) return { ok: false, error: "brand" };
  if (!expiryOk(input.expMonth, input.expYear)) return { ok: false, error: "expiry" };
  if (!cvcOk(input.cvc)) return { ok: false, error: "cvc" };
  return {
    ok: true,
    pan,
    expMonth: input.expMonth,
    expYear: normalizeYear(input.expYear),
    cvc: input.cvc,
    brand,
    last4: pan.slice(-4),
  };
}

export function makeCardToken(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function linkFresh(expiresAtMs: number, used: boolean, nowMs: number): boolean {
  return !used && expiresAtMs > nowMs;
}

export function cardLinkUrl(origin: string, token: string): string {
  return `${origin}/card.html?t=${token}`;
}

export function cardPlain(pan: string, cvc: string): string {
  return `${pan}|${cvc}`;
}

export function splitCardPlain(s: string): { pan: string; cvc: string } {
  const i = s.indexOf("|");
  if (i < 0) return { pan: s, cvc: "" };
  return { pan: s.slice(0, i), cvc: s.slice(i + 1) };
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function encryptCard(plain: string, keyHex: string): Promise<string> {
  const keyBytes = hexToBytes(keyHex);
  if (keyBytes.length !== 32) throw new Error("key length");
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await globalThis.crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
  ]);
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

export async function decryptCard(blob: string, keyHex: string): Promise<string> {
  const keyBytes = hexToBytes(keyHex);
  if (keyBytes.length !== 32) throw new Error("key length");
  const all = b64ToBytes(blob);
  if (all.length < 13) throw new Error("blob");
  const iv = all.slice(0, 12);
  const ct = all.slice(12);
  const key = await globalThis.crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "decrypt",
  ]);
  const pt = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export function modelPayloadHasPan(payload: unknown, pan: string): boolean {
  const dig = digitsOnly(pan);
  if (!dig) return false;
  return JSON.stringify(payload).includes(dig);
}

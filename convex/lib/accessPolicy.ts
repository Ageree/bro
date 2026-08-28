const ALPH = "abcdefghijklmnopqrstuvwxyz0123456789";

export function makeHandle(rand: () => number = Math.random): string {
  let s = "bro-";
  for (let i = 0; i < 8; i++) s += ALPH[Math.floor(rand() * ALPH.length)]!;
  return s;
}

export function isValidHandle(h: string): boolean {
  return /^bro-[a-z0-9]{8}$/.test(h);
}

export function isIosUserAgent(ua: string): boolean {
  return /iPhone|iPad|iPod/i.test(ua);
}

export function inboundPhoneAction(
  bound: string | undefined,
  incoming: string,
): "bind" | "ok" | "reject" {
  if (!bound) return "bind";
  if (bound === incoming) return "ok";
  return "reject";
}

export const DEFAULT_IDENTITY_CAP = 100;

export function identityCap(
  raw: string | undefined = process.env.BRO_IDENTITY_CAP,
): number {
  const n = Number(raw ?? DEFAULT_IDENTITY_CAP);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDENTITY_CAP;
}

export function identityCapReached(count: number, cap: number): boolean {
  return count >= cap;
}

export function webhookUrlForHandle(base: string, handle: string): string {
  const u = new URL(base);
  u.searchParams.set("h", handle);
  return u.toString();
}

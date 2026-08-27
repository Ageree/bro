/** Constant-time compare via XOR fold. No node:crypto (Convex query/mutation runtime). */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

export function assertSecret(secret: string): void {
  const expected = process.env.BRO_INTERNAL_SECRET ?? "";
  if (expected.length === 0) throw new Error("BRO_INTERNAL_SECRET is not set");
  if (!timingSafeEqual(secret, expected)) throw new Error("unauthorized");
}

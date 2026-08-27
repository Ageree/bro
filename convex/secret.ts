/**
 * Compare `input` to `expected` in time that depends on input length only.
 * Length mismatch is one XOR bit; the loop never walks the stored secret.
 */
export function timingSafeEqual(input: string, expected: string): boolean {
  const n = input.length;
  const m = expected.length;
  let diff = n ^ m;
  const wrap = m > 0 ? m : 1;
  for (let i = 0; i < n; i++) {
    diff |= input.charCodeAt(i) ^ (expected.charCodeAt(i % wrap) || 0);
  }
  return diff === 0;
}

export function assertSecret(secret: string): void {
  const expected = process.env.BRO_INTERNAL_SECRET ?? "";
  if (expected.length === 0) throw new Error("BRO_INTERNAL_SECRET is not set");
  if (!timingSafeEqual(secret, expected)) throw new Error("unauthorized");
}

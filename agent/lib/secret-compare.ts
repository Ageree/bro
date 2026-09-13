import { timingSafeEqual } from "node:crypto";

/** Constant-time string equality. False for non-strings, empty expected, or length mismatch. */
export function secretEquals(got: unknown, expected: string | undefined): boolean {
  if (typeof got !== "string" || !expected) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function assertSecret(secret: string): void {
  const expected = process.env.BRO_INTERNAL_SECRET;
  if (!expected) throw new Error("BRO_INTERNAL_SECRET is not set");
  if (secret !== expected) throw new Error("unauthorized");
}

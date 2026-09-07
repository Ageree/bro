export function parkTurn(
  waitUntil: ((work: Promise<unknown>) => void) | undefined,
  work: Promise<unknown>,
): void {
  if (typeof waitUntil === "function") waitUntil(work);
  else void work;
}

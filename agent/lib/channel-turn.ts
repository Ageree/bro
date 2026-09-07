/** Human webhooks should ack 204 without waiting out the Eve turn.
 *  Inkbox/Telegram retries of a slow handler cancel the in-flight turn
 *  (`turnPolicy: "steer"`). Convex wakeups still await `send` so dispatch
 *  can see a real failure. */

export function parkTurn(
  waitUntil: ((work: Promise<unknown>) => void) | undefined,
  work: Promise<unknown>,
): void {
  if (typeof waitUntil === "function") waitUntil(work);
  else void work;
}

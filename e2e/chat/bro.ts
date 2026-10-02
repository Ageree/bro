import { expect, type Screen } from "e2e";

/** How long Bro may take over one turn, model calls and tools included. */
const turnTimeout = 180_000;

/**
 * Sends a message from the composer and waits for Bro's turn to end: while a
 * turn runs, the composer's button is «Stop» instead of «Submit». Waiting
 * for one reply bubble is not enough — Bro answers in several, and a message
 * sent mid-turn steers the running turn instead of starting the next one.
 */
export async function sendToBro(screen: Screen, text: string) {
  await screen.getByRole("textbox", "Напиши Bro…").fill(text);
  await screen.getByRole("button", "Submit").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible({
    timeout: 60_000,
  });
  await expect(screen.getByRole("button", "Submit")).toBeVisible({
    timeout: turnTimeout,
  });
}

/**
 * The conversation. Its element is `role="log"`, a role the runner's
 * `getByRole` does not type, so the page's main region stands in: past the
 * log it holds only the empty composer and the activity rail.
 */
export function chatLog(screen: Screen) {
  return screen.getByRole("main");
}

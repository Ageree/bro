import type { Browser } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

/** How long Bro may take over one turn, model calls and tools included. */
const turnTimeout = 180_000;

/**
 * The conversation. Its element is `role="log"`, a role the runner's
 * `getByRole` does not type, hence the raw selector.
 */
export function chatLog(browser: Browser) {
  return browser.locator('[role="log"]');
}

/** What the log shows after the last copy of `text`, timestamps dropped. */
async function replyAfter(browser: Browser, text: string) {
  const log = (await chatLog(browser).textContent()) ?? "";
  const sent = log.lastIndexOf(text);
  if (sent === -1) return "";
  return (
    log
      .slice(sent + text.length)
      // Only whole timestamp tokens: «в 10:30» inside a reply stays.
      .replaceAll(
        /(?<=^|\s)\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?(?=\s|$)/gu,
        ""
      )
      .replaceAll(/\s+/gu, " ")
      .trim()
  );
}

/**
 * Sends a message from the composer and waits for Bro's turn to end. A
 * running turn shows «Stop» in the composer, but the page may never show it:
 * the first message moves the chat to `/chat/<id>`, which `next dev` may
 * still be compiling when a short turn ends. So the turn counts as over once
 * a reply follows the message, «Stop» is gone and the reply holds still for
 * one poll. Waiting for one bubble is not enough — Bro answers in several,
 * and a message sent mid-turn steers the running turn instead of starting
 * the next one. Returns the reply: what the log shows after the message.
 */
export async function sendToBro(
  { browser, screen }: { browser: Browser; screen: Screen },
  text: string
) {
  const stop = screen.getByRole("button", "Stop");
  await expect(stop).toHaveCount(0, { timeout: turnTimeout });

  await screen.getByRole("textbox", "Напиши Bro…").fill(text);
  await screen.getByRole("button", "Submit").tap();

  let lastReply = "";
  await expect
    .poll(
      async () => {
        const reply = await replyAfter(browser, text);
        if (reply === "" || (await stop.isVisible())) {
          lastReply = "";
          return false;
        }
        const settled = reply === lastReply;
        lastReply = reply;
        return settled;
      },
      {
        interval: 3_000,
        message: "Bro's turn did not end with a reply",
        timeout: turnTimeout,
      }
    )
    .toBe(true);
  return lastReply;
}

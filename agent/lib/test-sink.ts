/**
 * Where a test tenant's outbound goes instead of a phone.
 *
 * Both compiled forms are recorded, because a scenario wants to assert on
 * different things at different times: `text` is what the model decided to
 * say (the thing a behavioural test is usually about), `bubbles` is what the
 * human would actually have seen after `toIMessageBubbles` / `compileTelegram`
 * split and marked it up (the thing a formatting regression shows up in).
 */
import { toIMessageBubbles } from "./imessage-text.ts";
import { compileTelegram } from "./telegram-text.ts";
import { recordTestBubble } from "./convex.ts";

export type TestDelivery = {
  phoneE164: string;
  channel: "imessage" | "telegram";
  text: string;
};

export function compileTestBubbles(delivery: TestDelivery): string[] {
  if (delivery.channel === "telegram") {
    const compiled = compileTelegram(delivery.text);
    if (compiled.preferRich && compiled.richHtml) return [compiled.richHtml];
    return compiled.chunks.length ? compiled.chunks : [compiled.html];
  }
  return toIMessageBubbles(delivery.text);
}

export async function recordTestDelivery(delivery: TestDelivery): Promise<void> {
  await recordTestBubble({
    phoneE164: delivery.phoneE164,
    at: Date.now(),
    channel: delivery.channel,
    text: delivery.text,
    bubbles: compileTestBubbles(delivery),
  });
}

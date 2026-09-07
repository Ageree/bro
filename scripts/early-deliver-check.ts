import { readFileSync } from "node:fs";
import {
  bubblesFor,
  nextBubble,
  planTurnDelivery,
  recordSent,
  visibleReply,
} from "../agent/lib/early-deliver.ts";
import { TURN_FAILED_REPLY } from "../agent/lib/silent-turn.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(visibleReply(null) === null, "null invisible");
assert(visibleReply("   ") === null, "whitespace invisible");
assert(visibleReply("[SILENT]") === null, "silent invisible");
assert(visibleReply("[SILENT] leftover") === null, "silent prefix invisible");
assert(visibleReply("  Ищу  ") === "Ищу", "trim visible");

assert(nextBubble([], "Ищу") === "Ищу", "first bubble");
assert(nextBubble(["Ищу"], "Ищу") === null, "exact dup skipped");
assert(nextBubble(["Ищу"], "Ищу\n\nНашёл три варианта") === "Нашёл три варианта", "accumulated remainder");
assert(nextBubble(["Ищу"], "Нашёл три варианта") === "Нашёл три варианта", "new independent bubble");
assert(nextBubble(["Ищу кроссовки"], "Ищу") === null, "shorter prefix of last skipped");

const mid = planTurnDelivery({
  finishReason: "tool-calls",
  message: "Ищу 🔎",
  origin: "human",
  alreadySent: [],
});
assert(mid.send === "Ищу 🔎", "tool-calls text is delivered immediately");
assert(mid.fallback === null, "tool-calls never fallback");

const silentMid = planTurnDelivery({
  finishReason: "tool-calls",
  message: "[SILENT]",
  origin: "human",
  alreadySent: [],
});
assert(silentMid.send === null, "silent tool-calls stay quiet");

const seenMid = planTurnDelivery({
  finishReason: "tool-calls",
  message: "Цена та же\n[SEEN] abc",
  origin: "wakeup",
  alreadySent: [],
});
assert(seenMid.send === "Цена та же", "seen stripped on mid-turn");
assert(seenMid.seen === "abc", "seen captured on mid-turn");

const finalDup = planTurnDelivery({
  finishReason: "stop",
  message: "Ищу 🔎",
  origin: "human",
  alreadySent: ["Ищу 🔎"],
});
assert(finalDup.send === null, "final does not resend the mid-turn bubble");
assert(finalDup.fallback === null, "already spoke — no fallback");

const emptyAfterSpeak = planTurnDelivery({
  finishReason: "stop",
  message: null,
  origin: "human",
  alreadySent: ["Ищу"],
});
assert(emptyAfterSpeak.send === null, "empty final after speak");
assert(emptyAfterSpeak.fallback === null, "do not claim failure after a real bubble");

const emptyHuman = planTurnDelivery({
  finishReason: "stop",
  message: null,
  origin: "human",
  alreadySent: [],
});
assert(emptyHuman.fallback === TURN_FAILED_REPLY, "empty human turn still fallbacks");

const emptyWakeup = planTurnDelivery({
  finishReason: "stop",
  message: "",
  origin: "wakeup",
  alreadySent: [],
});
assert(emptyWakeup.fallback === null, "wakeup may end empty");

const sent = new Map<string, { at: number; bubbles: string[] }>();
recordSent(sent, "t1", "Ищу", 1_000);
assert(bubblesFor(sent, "t1").join("|") === "Ищу", "record first");
recordSent(sent, "t1", "Нашёл", 2_000);
assert(bubblesFor(sent, "t1").join("|") === "Ищу|Нашёл", "record second");
assert(bubblesFor(sent, "t2").length === 0, "other turn empty");
recordSent(sent, "t1", "старое", 1_000 + 11 * 60_000);
assert(bubblesFor(sent, "t1").join("|") === "старое", "ttl expires the old row");

const channel = readFileSync(
  new URL("../agent/channels/imessage.ts", import.meta.url),
  "utf8",
);
assert(channel.includes("planTurnDelivery"), "imessage uses early-deliver planner");
assert(
  !/if \(event\.finishReason === ["']tool-calls["']\) return;/.test(channel),
  "imessage no longer drops tool-calls text",
);
assert(
  !shouldSkipAgentOnAck(channel),
  "acks still reach the agent — ok/спасибо can continue a waiting job",
);

function shouldSkipAgentOnAck(src: string): boolean {
  return src.includes("instantTapback");
}

console.log("early-deliver-check ok");

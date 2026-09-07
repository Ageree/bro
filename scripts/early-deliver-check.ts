import { readFileSync } from "node:fs";
import {
  bubblesFor,
  nextBubble,
  planTurnDelivery,
  recordSent,
  visibleReply,
} from "../agent/lib/early-deliver.ts";
import { parkTurn } from "../agent/lib/channel-turn.ts";
import { TURN_FAILED_REPLY } from "../agent/lib/silent-turn.ts";
import { routingFromAuth, routingPhone } from "../agent/lib/turn-routing.ts";

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

const silentFinal = planTurnDelivery({
  finishReason: "stop",
  message: "[SILENT]",
  origin: "human",
  alreadySent: [],
});
assert(silentFinal.send === null, "final [SILENT] stays hidden");
assert(silentFinal.fallback === null, "[SILENT] is not a failure — tapback / ок");

const silentSeen = planTurnDelivery({
  finishReason: "stop",
  message: "[SILENT]\n[SEEN] price=1",
  origin: "human",
  alreadySent: [],
});
assert(silentSeen.send === null, "silent+seen stays hidden");
assert(silentSeen.fallback === null, "silent+seen is not a failure");
assert(silentSeen.seen === "price=1", "seen still captured on silent");

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

let parked = 0;
parkTurn((work) => {
  parked += 1;
  void work;
}, Promise.resolve());
assert(parked === 1, "parkTurn uses waitUntil when present");
parkTurn(undefined, Promise.resolve());
assert(parked === 1, "missing waitUntil does not throw");

const telegramHuman = routingFromAuth({
  origin: "human",
  channel: "telegram",
  telegramChatId: "42",
});
assert(telegramHuman.canDeliver === true, "telegram attrs deliver without tenant");
assert(telegramHuman.channel === "telegram", "telegram channel from attrs");
assert(telegramHuman.telegramChatId === "42", "telegram chat id from attrs");

const imessageHuman = routingFromAuth({
  origin: "human",
  inkboxHandle: "+7999",
});
assert(imessageHuman.canDeliver === true, "human iMessage delivers without tenant");
assert(imessageHuman.channel === "imessage", "human iMessage stays on this conversation");

const wakeup = routingFromAuth({
  origin: "wakeup",
  conversationId: "c1",
  inkboxHandle: "+7999",
});
assert(wakeup.canDeliver === false, "wakeup still needs tenant lastChannel");
assert(wakeup.channel === undefined, "wakeup does not guess iMessage from handle");

const group = routingFromAuth({
  origin: "human",
  inkboxHandle: "+7999",
  ownerPhone: "+7000",
});
assert(routingPhone(group, undefined) === "+7000", "group seen uses ownerPhone");
assert(routingPhone(group, "+7111") === "+7111", "principal wins over owner");

assert(channel.includes("routingFromAuth"), "imessage uses auth routing");
assert(channel.includes("deliverTurnBubble"), "imessage shares delivery helper");
assert(
  !/await setWakeupLastSeen/.test(channel),
  "lastSeen is not awaited before the bubble",
);
assert(
  !/if \(bubblesFor\(earlySent, event\.turnId\)\.length > 0\) return;/.test(
    channel,
  ),
  "turn.failed still speaks after an early bubble",
);

console.log("early-deliver-check ok");

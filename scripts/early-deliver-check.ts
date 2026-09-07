import { readFileSync } from "node:fs";
import {
  bubblesFor,
  firstCompleteLine,
  isLikelyCompleteBubble,
  markTurnSpoke,
  nextBubble,
  turnSpoke,
  planFirstLineFlush,
  planPreToolFlush,
  planStreamFlush,
  planTurnDelivery,
  recordSent,
  visibleReply,
} from "../agent/lib/early-deliver.ts";
import { parkTurn } from "../agent/lib/channel-turn.ts";
import { TURN_FAILED_REPLY } from "../agent/lib/silent-turn.ts";
import { routingFromAuth, routingPhone } from "../agent/lib/turn-routing.ts";
import { channelFromAuth } from "../agent/lib/deliver-routed.ts";

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

assert(firstCompleteLine("Ищу") === null, "partial first line stays");
assert(firstCompleteLine("\nИ") === null, "leading newline does not flush a crumb");
assert(firstCompleteLine("Ищу кроссовки\n") === "Ищу кроссовки", "newline completes the line");
assert(firstCompleteLine("[SILENT]\n") === null, "silent first line stays hidden");
assert(
  firstCompleteLine("Цена та же\n[SEEN] abc") === "Цена та же",
  "seen does not block a complete first line",
);

const streamFirst = planFirstLineFlush({ soFar: "Ищу 🔎\n", alreadySent: [] });
assert(streamFirst.send === "Ищу 🔎", "appended flushes the first complete line");

const streamPartial = planFirstLineFlush({ soFar: "Ищ", alreadySent: [] });
assert(streamPartial.send === null, "appended does not send a token crumb");

const streamAfter = planFirstLineFlush({
  soFar: "Ищу 🔎\n\nНашёл три варианта",
  alreadySent: ["Ищу 🔎"],
});
assert(streamAfter.send === null, "unterminated later text does not flush");
const streamNext = planStreamFlush({
  soFar: "Ищу 🔎\n\nНашёл три варианта\n",
  alreadySent: ["Ищу 🔎"],
});
assert(streamNext.send === "Нашёл три варианта", "later complete line flushes the remainder");
assert(
  planStreamFlush({
    soFar: "Ищу\nНашёл\nИтог\n",
    alreadySent: ["Ищу", "Нашёл"],
  }).send === "Итог",
  "third complete line is only the remainder after two bubbles",
);
assert(
  nextBubble(["Ищу", "Нашёл"], "Ищу\nНашёл\nИтог") === "Итог",
  "single-newline join still yields the last line",
);
assert(
  nextBubble(["Ок."], "Ок. Сейчас гляну джоб") === "Сейчас гляну джоб",
  "sentence flush remainder does not resend the first bubble",
);
assert(
  nextBubble(["ок"], "окей, сделаю") === "окей, сделаю",
  "ок is not a prefix of окей",
);

assert(isLikelyCompleteBubble("Ок!"), "exclaim is complete");
assert(isLikelyCompleteBubble("Ок."), "ок + period is complete");
assert(isLikelyCompleteBubble("Принял."), "long word + period is complete");
assert(isLikelyCompleteBubble("👍"), "emoji-only is complete");
assert(!isLikelyCompleteBubble("Ищ"), "crumb is not complete");
assert(!isLikelyCompleteBubble("Ищу ПВЗ на ул."), "abbreviation period is not complete");
assert(!isLikelyCompleteBubble("Нашёл три варианта"), "unterminated sentence stays");

assert(
  planStreamFlush({ soFar: "Ок!", alreadySent: [] }).send === "Ок!",
  "stream flushes a finished short reply without waiting for newline",
);
assert(
  planStreamFlush({ soFar: "Ищу ПВЗ на ул.", alreadySent: [] }).send === null,
  "stream does not flush an abbreviation",
);
assert(
  planStreamFlush({ soFar: "Ок.", alreadySent: [] }).send === "Ок.",
  "stream flushes ок with a period",
);

const streamThenFinal = planTurnDelivery({
  finishReason: "tool-calls",
  message: "Ищу 🔎\n\nНашёл три варианта",
  origin: "human",
  alreadySent: ["Ищу 🔎"],
});
assert(
  streamThenFinal.send === "Нашёл три варианта",
  "completed still sends the remainder after a streamed first line",
);
assert(
  nextBubble(["Ищу 🔎"], "Ищу 🔎  \n\nНашёл три варианта") === "Нашёл три варианта",
  "trailing spaces on the flushed line still yield the remainder",
);

const preTool = planPreToolFlush({ soFar: "Ищу кроссовки", alreadySent: [] });
assert(preTool.send === "Ищу кроссовки", "tool start flushes a line that never got a newline");
const preToolAfter = planPreToolFlush({
  soFar: "Ищу кроссовки",
  alreadySent: ["Ищу кроссовки"],
});
assert(preToolAfter.send === null, "tool start does not resend the streamed line");

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

markTurnSpoke("turn-a", 1_000);
assert(turnSpoke("turn-a", 1_500), "this turn spoke");
assert(!turnSpoke("turn-b", 1_500), "other turn has not spoken");
assert(!turnSpoke("turn-a", 1_000 + 11 * 60_000), "turn spoke ttl expires");

const sent = new Map<string, { at: number; bubbles: string[]; soFar?: string }>();
recordSent(sent, "t1", "Ищу", 1_000);
assert(bubblesFor(sent, "t1").join("|") === "Ищу", "record first");
assert(turnSpoke("t1", 1_000), "recordSent marks this turn as spoken");
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
assert(channel.includes("planStreamFlush"), "imessage flushes streamed complete lines");
assert(channel.includes("planPreToolFlush"), "imessage flushes when the model starts a tool");
assert(channel.includes('"message.appended"'), "imessage listens for streamed text");
assert(channel.includes('"actions.requested"'), "imessage listens for the pre-tool boundary");
assert(channel.includes("void deliverTurnBubble"), "early bubbles do not block the Eve pump");
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
assert(
  channelFromAuth({ origin: "human", channel: "telegram", telegramChatId: "1" }, "imessage") ===
    "telegram",
  "tool notify follows auth, not stale lastChannel",
);
assert(
  channelFromAuth({ origin: "wakeup" }, "telegram") === "telegram",
  "wakeup tool notify still uses lastChannel",
);

assert(channel.includes("routingFromAuth"), "imessage uses auth routing");
assert(channel.includes("deliverTurnBubble"), "imessage shares delivery helper");
const bubbleFn = channel.slice(channel.indexOf("async function deliverTurnBubble"));
assert(
  bubbleFn.indexOf("deliverHuman") < bubbleFn.indexOf("persistSeen"),
  "lastSeen waits until after the bubble is sent",
);
const appended = channel.slice(channel.indexOf('"message.appended"'));
assert(
  appended.indexOf("recordSent") < appended.indexOf("void deliverTurnBubble"),
  "appended recordSent before deliver closes the overlap window",
);
const preToolEv = channel.slice(
  channel.indexOf('"actions.requested"'),
  channel.indexOf('"message.completed"'),
);
assert(
  preToolEv.indexOf("recordSent") < preToolEv.indexOf("void deliverTurnBubble"),
  "pre-tool recordSent before deliver closes the overlap window",
);
assert(
  !preToolEv.includes("await deliverTurnBubble"),
  "pre-tool send is not awaited",
);
const completed = channel.slice(channel.indexOf('"message.completed"'));
assert(
  completed.indexOf("recordSent") < completed.indexOf("await deliverTurnBubble"),
  "recordSent before deliver closes the overlap window",
);
assert(
  !/if \(bubblesFor\(earlySent, event\.turnId\)\.length > 0\) return;/.test(
    channel,
  ),
  "turn.failed still speaks after an early bubble",
);

console.log("early-deliver-check ok");

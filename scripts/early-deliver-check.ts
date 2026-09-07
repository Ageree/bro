import { readFileSync } from "node:fs";
import {
  bubblesFor,
  firstCompleteLine,
  isLikelyCompleteBubble,
  markTurnSpoke,
  nextBubble,
  turnLooking,
  turnSpoke,
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
import {
  imessageOwnsTurn,
  telegramOwnsTurn,
} from "../agent/lib/turn-delivery-events.ts";

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

const streamFirst = planStreamFlush({ soFar: "Ищу 🔎\n", alreadySent: [] });
assert(streamFirst.send === "Ищу 🔎", "appended flushes the first complete line");

const streamPartial = planStreamFlush({ soFar: "Ищ", alreadySent: [] });
assert(streamPartial.send === null, "appended does not send a token crumb");

const streamAfter = planStreamFlush({
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
assert(
  nextBubble(
    [
      "Записываю в Инвитро на чекап.",
      "Открываю браузер — подберу ближайшее время и филиал.",
      "Здесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть).",
    ],
    "Записываю в Инвитро на чекап. Открываю браузер — подберу ближайшее время и филиал.\nЗдесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть). Два варианта:",
  ) === "Два варианта:",
  "sentence peels on one line still yield only the new tail",
);
assert(
  nextBubble(
    [
      "Здесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть). Два варианта:",
    ],
    "Два варианта:",
  ) === null,
  "suffix of an already-sent bubble is not resent",
);

{
  const sent = new Map<string, { at: number; bubbles: string[] }>();
  const turn = "invitro";
  const soFar = [
    "Записываю в Инвитро на чекап.",
    "Записываю в Инвитро на чекап. Открываю браузер — подберу ближайшее время и филиал.",
    "Записываю в Инвитро на чекап. Открываю браузер — подберу ближайшее время и филиал.\nЗдесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть). Два варианта:",
    "Записываю в Инвитро на чекап. Открываю браузер — подберу ближайшее время и филиал.\nЗдесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть). Два варианта:\n1. Подключаешь оплату лимита — сразу ищу филиал и время, записываю сам.",
    "Записываю в Инвитро на чекап. Открываю браузер — подберу ближайшее время и филиал.\nЗдесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть). Два варианта:\n1. Подключаешь оплату лимита — сразу ищу филиал и время, записываю сам.\n2. Или я скину ссылку на страницу записи Инвитро, и ты за пару кликов выберешь филиал и время сам — я только напомню и прослежу, чтобы не забыл.\nЧто выбираешь?",
  ];
  const flushed: string[] = [];
  for (const chunk of soFar) {
    const planned = planStreamFlush({
      soFar: chunk,
      alreadySent: bubblesFor(sent, turn),
    });
    if (planned.send) {
      recordSent(sent, turn, planned.send, Date.now());
      flushed.push(planned.send);
    }
  }
  const final = planTurnDelivery({
    finishReason: "stop",
    message: soFar[soFar.length - 1],
    origin: "human",
    alreadySent: bubblesFor(sent, turn),
  });
  assert(
    flushed[0] === "Записываю в Инвитро на чекап.",
    "first status line still leaves early",
  );
  assert(
    !flushed.some((b) => b.includes("Записываю") && b.includes("Два варианта")),
    "stream must not resend the already-flushed status lines",
  );
  assert(final.send === null, "completed must not replay the whole reply");
}

assert(isLikelyCompleteBubble("Ок!"), "exclaim is complete");
assert(isLikelyCompleteBubble("Ок."), "ок + period is complete");
assert(isLikelyCompleteBubble("Принял."), "long word + period is complete");
assert(isLikelyCompleteBubble("👍"), "emoji-only is complete");
assert(!isLikelyCompleteBubble("Ищ"), "crumb is not complete");
assert(!isLikelyCompleteBubble("Ищу ПВЗ на ул."), "abbreviation period is not complete");
assert(!isLikelyCompleteBubble("Ищу на Невском просп."), "просп. is not complete");
assert(!isLikelyCompleteBubble("бюджет 2 млрд."), "млрд. is not complete");
assert(!isLikelyCompleteBubble("Нашёл три варианта"), "unterminated sentence stays");
assert(!isLikelyCompleteBubble("Ищу 🔎"), "looking line with emoji is not a finished bubble");
assert(isLikelyCompleteBubble("Ок 👍"), "ack plus emoji is complete");
assert(!isLikelyCompleteBubble("Нашёл за 8490."), "price period is not a sentence");
assert(!isLikelyCompleteBubble("Ищу… кроссовки"), "ellipsis looking line is not peeled");
assert(!isLikelyCompleteBubble("Ищу..."), "ascii ellipsis looking line stays");
assert(
  planStreamFlush({ soFar: "Ищу... кроссовки", alreadySent: [] }).send === null,
  "ascii ellipsis does not peel Ищу.",
);
assert(!isLikelyCompleteBubble("Нашёл за 8490р."), "8490р. is still a price");
assert(
  nextBubble(["Готово!"], "Готово к отправке") === "Готово к отправке",
  "bare last word plus space is a new sentence, not a remainder",
);

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
assert(
  planStreamFlush({ soFar: "Ок. Сейчас гляну джоб", alreadySent: [] }).send === "Ок.",
  "batched first sentence peels off the open line",
);
assert(
  nextBubble(["Привет!"], "Привет. Как дела?") === "Как дела?",
  "punct rewrite still yields the remainder",
);
assert(
  nextBubble(["ok"], "ok, сделаю") === "сделаю",
  "comma after a flushed ack is stripped",
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
assert(turnLooking("t1", 1_000), "ищу bubble marks the turn as looking");
recordSent(sent, "t-ack", "Ок!", 1_000);
assert(!turnLooking("t-ack", 1_000), "ок bubble is not a looking line");
recordSent(sent, "t1", "Нашёл", 2_000);
assert(bubblesFor(sent, "t1").join("|") === "Ищу|Нашёл", "record second");
assert(bubblesFor(sent, "t2").length === 0, "other turn empty");
recordSent(sent, "t1", "старое", 1_000 + 11 * 60_000);
assert(bubblesFor(sent, "t1").join("|") === "старое", "ttl expires the old row");

const channel = readFileSync(
  new URL("../agent/channels/imessage.ts", import.meta.url),
  "utf8",
);
const delivery = readFileSync(
  new URL("../agent/lib/turn-delivery-events.ts", import.meta.url),
  "utf8",
);
const telegramChannel = readFileSync(
  new URL("../agent/channels/telegram.ts", import.meta.url),
  "utf8",
);
assert(channel.includes("createTurnDeliveryEvents"), "imessage uses shared delivery events");
assert(channel.includes("imessageOwnsTurn"), "imessage skips telegram-stamped turns");
assert(telegramChannel.includes("createTurnDeliveryEvents"), "telegram uses shared delivery events");
assert(telegramChannel.includes("telegramOwnsTurn"), "telegram accepts only telegram-stamped turns");
assert(delivery.includes("planTurnDelivery"), "shared events use early-deliver planner");
assert(delivery.includes("planStreamFlush"), "shared events flush streamed complete lines");
assert(delivery.includes("planPreToolFlush"), "shared events flush when the model starts a tool");
assert(delivery.includes('"message.appended"'), "shared events listen for streamed text");
assert(delivery.includes('"actions.requested"'), "shared events listen for the pre-tool boundary");
assert(delivery.includes("void deliverTurnBubble"), "early bubbles do not block the Eve pump");
assert(
  !/if \(event\.finishReason === ["']tool-calls["']\) return;/.test(delivery),
  "shared events no longer drop tool-calls text",
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

assert(telegramOwnsTurn({ origin: "human", channel: "telegram", telegramChatId: "1" }), "telegram stamp");
assert(!telegramOwnsTurn({ origin: "human" }), "human iMessage is not telegram-owned");
assert(!telegramOwnsTurn({ origin: "wakeup" }), "wakeup is not telegram-owned");
assert(imessageOwnsTurn({ origin: "human" }), "human iMessage stays on imessage events");
assert(imessageOwnsTurn({ origin: "wakeup" }), "wakeup stays on imessage events");
assert(
  !imessageOwnsTurn({ origin: "human", channel: "telegram", telegramChatId: "1" }),
  "imessage events skip telegram-stamped turns",
);

assert(delivery.includes("routingFromAuth"), "shared events use auth routing");
assert(delivery.includes("deliverTurnBubble"), "shared events share delivery helper");
const bubbleFn = delivery.slice(delivery.indexOf("export async function deliverTurnBubble"));
assert(
  bubbleFn.indexOf("deliverHuman") < bubbleFn.indexOf("persistSeen"),
  "lastSeen waits until after the bubble is sent",
);
const appended = delivery.slice(delivery.indexOf('"message.appended"'));
assert(
  appended.indexOf("recordSent") < appended.indexOf("void deliverTurnBubble"),
  "appended recordSent before deliver closes the overlap window",
);
const preToolEv = delivery.slice(
  delivery.indexOf('"actions.requested"'),
  delivery.indexOf('"message.completed"'),
);
assert(
  preToolEv.indexOf("recordSent") < preToolEv.indexOf("void deliverTurnBubble"),
  "pre-tool recordSent before deliver closes the overlap window",
);
assert(
  !preToolEv.includes("await deliverTurnBubble"),
  "pre-tool send is not awaited",
);
const completed = delivery.slice(delivery.indexOf('"message.completed"'));
assert(
  completed.indexOf("recordSent") < completed.indexOf("await deliverTurnBubble"),
  "recordSent before deliver closes the overlap window",
);
assert(
  !/if \(bubblesFor\(earlySent, event\.turnId\)\.length > 0\) return;/.test(
    delivery,
  ),
  "turn.failed still speaks after an early bubble",
);

console.log("early-deliver-check ok");

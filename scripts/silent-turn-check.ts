import {
  browserPollForceSpeak,
  fallbackForFailed,
  isSilentReply,
  takeFallbackSlot,
  TURN_FAILED_REPLY,
  turnOrigin,
  wakeupFallbackText,
} from "../agent/lib/silent-turn.ts";

import { assert, src } from "./lib/check.ts";

// origin is read from channel auth attributes; wire v1 may deliver arrays
assert(turnOrigin({ origin: "human" }) === "human", "origin human");
assert(turnOrigin({ origin: ["wakeup"] }) === "wakeup", "origin array");
assert(turnOrigin({ origin: "bot" }) === undefined, "unknown origin");
assert(turnOrigin(undefined) === undefined, "no attributes");

assert(isSilentReply("[SILENT]") === true, "silent marker");
assert(isSilentReply("  [SILENT] leftover") === true, "silent prefix");
assert(isSilentReply("Ищу") === false, "visible is not silent");
assert(fallbackForFailed({ origin: "human" }) === TURN_FAILED_REPLY, "failed human turn");
assert(
  fallbackForFailed({ origin: "wakeup" }) === null,
  "failed un-phased wakeup stays quiet",
);
assert(fallbackForFailed(undefined) === null, "failed unknown stays quiet");
assert(
  fallbackForFailed({
    origin: "wakeup",
    wakeupKind: "reminder",
    wakeupFallback: "x",
  }) === null,
  "failed non-browser wakeup (reminder) stays quiet even with a stamped fallback",
);
assert(
  fallbackForFailed({
    origin: "wakeup",
    wakeupKind: "browser_poll",
    wakeupPhase: "done",
    wakeupFallback: "Готово: Такси заказано… 508 ₽, через ~2 мин.",
  }) === "Готово: Такси заказано… 508 ₽, через ~2 мин.",
  "a failed (thrown) browser_poll done turn still delivers the canned outcome — 2026-09-05 taxi incident",
);
assert(
  fallbackForFailed({
    origin: "wakeup",
    wakeupKind: "browser_poll",
    wakeupPhase: "done",
  }) === null,
  "failed browser_poll turn with no stamped fallback text stays quiet",
);

// one bubble per turn even if message.completed(empty) and turn.failed both fire
const sent = new Map<string, number>();
assert(takeFallbackSlot(sent, "t1", 1_000), "first slot");
assert(!takeFallbackSlot(sent, "t1", 2_000), "second slot for same turn refused");
assert(takeFallbackSlot(sent, "t2", 2_000), "other turn ok");
assert(takeFallbackSlot(sent, "t1", 1_000 + 11 * 60_000), "slot expires after ttl");

assert(TURN_FAILED_REPLY.length < 120 && !/[*_`#\[]/.test(TURN_FAILED_REPLY), "plain short iMessage line");
// It is the one line a human sees when the turn blew up — it has to read like
// a person owning up, on «ты», not like a support desk or a mascot.
assert(!TURN_FAILED_REPLY.includes("\n"), "the fallback is a single line");
assert(
  !/\bВы\b|\bВам\b|Напишите|Извините|Приносим|пожалуйста/i.test(TURN_FAILED_REPLY),
  "the fallback stays on «ты» and out of support-desk register",
);
assert(/напиши|попроб/i.test(TURN_FAILED_REPLY), "the fallback tells the human what to do next");
assert(/разбира|чиню|чин/i.test(TURN_FAILED_REPLY), "the fallback says Bro is already on it");

// --- A2: never-silent wakeup fallback (goal.md §2 / A7 finding B3) ---

assert(
  wakeupFallbackText({ origin: "wakeup", wakeupFallback: "Нужен код из SMS." }) ===
    "Нужен код из SMS.",
  "wakeup fallback surfaces the stamped line",
);
assert(
  wakeupFallbackText({ origin: "human", wakeupFallback: "x" }) === null,
  "human turn never uses the wakeup fallback",
);
assert(wakeupFallbackText({ origin: "wakeup" }) === null, "no stamped fallback → null");
assert(wakeupFallbackText(undefined) === null, "no attrs → null");

for (const phase of ["done", "need", "failed", "giveup"]) {
  assert(
    browserPollForceSpeak({ origin: "wakeup", wakeupKind: "browser_poll", wakeupPhase: phase }) ===
      true,
    `browser_poll ${phase} forces speech`,
  );
}
assert(
  browserPollForceSpeak({ origin: "wakeup", wakeupKind: "job_check", wakeupPhase: "done" }) ===
    false,
  "job_check keeps its own force-speak path",
);

// The fallback must never re-state a bubble the turn already spoke (e.g. a
// «код из почты, ввожу» line streamed before the tool call that ends the
// turn empty) — gated on the same bubblesFor(...) real-bubble check the
// human TURN_FAILED_REPLY path already relies on via planTurnDelivery's
// `realSent`. No convex-test-style harness exists here to drive the actual
// event handler, so this is a source assertion, same style as the other
// *-check.ts files that pin exact wiring in a file they don't otherwise import.
const deliverySrc = src("agent/lib/turn-delivery-events.ts");
const failedHandler = deliverySrc.slice(
  deliverySrc.indexOf('"turn.failed"'),
  deliverySrc.indexOf('"message.appended"'),
);
assert(
  failedHandler.includes("fallbackForFailed(auth?.attributes)"),
  "turn.failed passes the full attrs so a browser_poll wakeup can still speak — 2026-09-05 taxi incident",
);
const completedHandler = deliverySrc.slice(deliverySrc.indexOf('"message.completed"'));
assert(
  completedHandler.includes("bubblesFor(earlySent, event.turnId).some"),
  "wakeup fallback checks whether the turn already spoke a real bubble",
);
assert(
  completedHandler.indexOf("const spoke =") <
    completedHandler.indexOf("wakeupFallbackText(auth"),
  "the spoke check is computed before the wakeup fallback is looked up",
);
assert(
  completedHandler.includes("!spoke\n          ? wakeupFallbackText") ||
    /&&\s*!spoke\b/.test(completedHandler),
  "wakeup fallback is gated on !spoke",
);

// A `message.completed` delivery is not a fire-and-forget like
// message.appended/actions.requested (it's the last chance for this event),
// so a failed send must be logged, not left as a silent unhandled rejection
// — and a resolved browser_poll wakeup gets one retry rather than nothing.
const sendPlanBlock = completedHandler.slice(
  completedHandler.indexOf("if (planned.send)"),
  completedHandler.indexOf("await persistSeenFromTurn"),
);
assert(
  sendPlanBlock.includes("deliverTurnBubble(bubbleOpts).catch"),
  "message.completed's deliverTurnBubble call is .catch-ed, not left to reject silently",
);
assert(
  sendPlanBlock.includes('console.error("message delivery failed"'),
  "a message.completed delivery failure is logged",
);
assert(
  sendPlanBlock.includes("browserPollForceSpeak(auth?.attributes)") &&
    sendPlanBlock.includes("deliverTurnBubble(bubbleOpts).catch((retryErr)"),
  "a browser_poll wakeup's message.completed delivery gets one retry on failure",
);

// --- the [background wakeup] prompts that tell the model what to SAY when a
// browser errand finished, failed, or was given up on. These are prompts, not
// copy, so the contract is: every hard constraint still stated, and the model
// is asked for its own human wording instead of one fixed formula. ---

const channelSrc = src("agent/channels/imessage.ts");

function wakeupPrompt(marker: string): string {
  const at = channelSrc.indexOf(marker);
  assert(at > 0, `wakeup prompt present: ${marker}`);
  const end = channelSrc.indexOf("`;", at);
  assert(end > at, `wakeup prompt terminated: ${marker}`);
  return channelSrc.slice(at, end);
}

const donePrompt = wakeupPrompt("[background wakeup] Поручение «${payload}» завершено");
assert(/своей формулировкой|своими словами|живыми словами/.test(donePrompt), "done asks for the model's own words");
assert(/каждый раз|по-новому|по-разному/.test(donePrompt), "done asks for varied wording, not one formula");
assert(donePrompt.includes("без канцелярита"), "done still bans канцелярит");
assert(donePrompt.includes("1–2 коротких пузыря"), "done still caps the answer at 1–2 bubbles");
assert(
  /номер заказа/.test(donePrompt) && /сумма/.test(donePrompt) && /когда/.test(donePrompt),
  "done still demands the load-bearing facts (order no., sum, when/where)",
);
assert(donePrompt.includes("Не вызывай browser_task"), "done still forbids re-checking with browser_task");
assert(donePrompt.includes("${variantsLine}"), "done still carries the variants rule");
assert(
  channelSrc.includes("Если в итоге есть ВАРИАНТЫ") && channelSrc.includes("одной строкой на вариант с ценой"),
  "the variants rule itself is unchanged",
);
for (const word of ["«джоб»", "«reset»", "«Cloud»"]) {
  assert(donePrompt.includes(word), `done bans the jargon word ${word}`);
}

const failedPrompt = wakeupPrompt("[background wakeup] Поручение «${payload}» не получилось");
assert(failedPrompt.includes("одной строкой"), "failed still asks for one line");
assert(/ещё раз/.test(failedPrompt) && /иначе/.test(failedPrompt), "failed still offers retry or another way");
assert(/своими словами|по-разному|не по шаблону/.test(failedPrompt), "failed asks for a human, varied line");
for (const word of ["«джоб»", "«reset»", "«Cloud»"]) {
  assert(failedPrompt.includes(word), `failed bans the jargon word ${word}`);
}

const giveupPrompt = wakeupPrompt("[background wakeup] Я остановил задачу");
assert(giveupPrompt.includes("одной строкой"), "giveup still asks for one line");
assert(giveupPrompt.includes("начать заново"), "giveup still offers to start over");
assert(/не по шаблону|своими словами|простыми словами/.test(giveupPrompt), "giveup asks for a human, varied line");
for (const word of ["«джоб»", "«reset»", "«Cloud»"]) {
  assert(giveupPrompt.includes(word), `giveup bans the jargon word ${word}`);
}

// None of these prompts may ever invite the model to ask for a secret.
for (const prompt of [donePrompt, failedPrompt, giveupPrompt]) {
  assert(!/попроси парол|спроси парол|запроси парол/i.test(prompt), "a wakeup prompt never asks for a password");
}

console.log("silent-turn-check ok");

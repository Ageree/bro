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
assert(fallbackForFailed("human") === TURN_FAILED_REPLY, "failed human turn");
assert(fallbackForFailed("wakeup") === null, "failed wakeup stays quiet");
assert(fallbackForFailed(undefined) === null, "failed unknown stays quiet");

// one bubble per turn even if message.completed(empty) and turn.failed both fire
const sent = new Map<string, number>();
assert(takeFallbackSlot(sent, "t1", 1_000), "first slot");
assert(!takeFallbackSlot(sent, "t1", 2_000), "second slot for same turn refused");
assert(takeFallbackSlot(sent, "t2", 2_000), "other turn ok");
assert(takeFallbackSlot(sent, "t1", 1_000 + 11 * 60_000), "slot expires after ttl");

assert(TURN_FAILED_REPLY.length < 120 && !/[*_`#\[]/.test(TURN_FAILED_REPLY), "plain short iMessage line");

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

console.log("silent-turn-check ok");

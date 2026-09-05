import {
  fallbackForCompleted,
  fallbackForFailed,
  takeFallbackSlot,
  TURN_FAILED_REPLY,
  turnOrigin,
} from "../agent/lib/silent-turn.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// origin is read from channel auth attributes; wire v1 may deliver arrays
assert(turnOrigin({ origin: "human" }) === "human", "origin human");
assert(turnOrigin({ origin: ["wakeup"] }) === "wakeup", "origin array");
assert(turnOrigin({ origin: "bot" }) === undefined, "unknown origin");
assert(turnOrigin(undefined) === undefined, "no attributes");

// 2026-09-05: human turn, tools threw, model ended with nothing → fallback
assert(
  fallbackForCompleted({ finishReason: "stop", message: null, origin: "human" }) ===
    TURN_FAILED_REPLY,
  "empty human turn gets a fallback",
);
assert(
  fallbackForCompleted({ finishReason: "error", message: "", origin: "human" }) ===
    TURN_FAILED_REPLY,
  "errored human turn gets a fallback",
);
assert(
  fallbackForCompleted({ finishReason: "stop", message: "   ", origin: "human" }) ===
    TURN_FAILED_REPLY,
  "whitespace-only counts as empty",
);

// mid-turn tool steps are not the end
assert(
  fallbackForCompleted({ finishReason: "tool-calls", message: null, origin: "human" }) === null,
  "tool-calls step is silent",
);

// the model said something (incl. [SILENT] after a tapback) → channel handles it
assert(
  fallbackForCompleted({ finishReason: "stop", message: "[SILENT]", origin: "human" }) === null,
  "explicit [SILENT] is not a failure",
);
assert(
  fallbackForCompleted({ finishReason: "stop", message: "Ищу 🔎", origin: "human" }) === null,
  "real reply needs no fallback",
);

// background wakeups may end empty
assert(
  fallbackForCompleted({ finishReason: "stop", message: null, origin: "wakeup" }) === null,
  "wakeup may end empty",
);
assert(
  fallbackForCompleted({ finishReason: "stop", message: null, origin: undefined }) === null,
  "unknown origin stays quiet (never spam)",
);
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

console.log("silent-turn-check ok");

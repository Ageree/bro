import {
  fallbackForFailed,
  isSilentReply,
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

console.log("silent-turn-check ok");

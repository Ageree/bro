import {
  browserAllowance,
  browserAllowedOnLimitError,
  browserGateFromResult,
  consumeCount,
  usedCount,
  dayKey,
  extendPaidUntil,
  inboundDecisionOnLimitError,
  inboundGateFromResult,
  isPaid,
  monthKey,
  msgAllowance,
  paywallDecision,
  rateLimitPeriodKey,
} from "../convex/lib/billingPolicy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(/^\d{4}-\d{2}-\d{2}$/.test(dayKey(Date.now())), "dayKey format");
assert(/^\d{4}-\d{2}$/.test(monthKey(Date.now())), "monthKey format");

// Europe/Moscow is UTC+3 year-round: 21:00Z is 00:00 next day.
const mskMidnight = Date.parse("2026-08-26T21:00:00.000Z");
assert(dayKey(mskMidnight) === "2026-08-27", "msk day rollover");
assert(monthKey(mskMidnight) === "2026-08", "msk month");
assert(dayKey(mskMidnight - 1) === "2026-08-26", "msk before rollover");

const mskNewYear = Date.parse("2025-12-31T21:00:00.000Z");
assert(dayKey(mskNewYear) === "2026-01-01", "msk year");
assert(monthKey(mskNewYear) === "2026-01", "msk month year");
assert(dayKey(mskNewYear - 1) === "2025-12-31", "msk before year");
assert(
  dayKey(Date.parse("2026-01-01T00:00:00.000Z"), "UTC") === "2026-01-01",
  "utc",
);

const now = Date.parse("2026-08-27T12:00:00.000Z");
assert(!isPaid(undefined, now), "unpaid");
assert(!isPaid(now, now), "not future");
assert(!isPaid(now - 1, now), "expired");
assert(isPaid(now + 1, now), "paid");

const month = 30 * 24 * 3600 * 1000;
assert(extendPaidUntil(undefined, now) === now + month, "from empty");
assert(extendPaidUntil(now - 1000, now) === now + month, "from past uses now");
assert(
  extendPaidUntil(now + 10_000, now) === now + 10_000 + month,
  "stacks on future",
);

assert(msgAllowance(false, {}) === 30, "free default");
assert(msgAllowance(true, {}) === 500, "paid default");
assert(msgAllowance(false, { free: "12" }) === 12, "free env");
assert(msgAllowance(true, { paid: "42" }) === 42, "paid env");
assert(msgAllowance(false, { free: "nope" }) === 30, "free garbage");
assert(msgAllowance(true, { paid: "0" }) === 500, "paid zero");

assert(browserAllowance(false, {}) === 5, "browser free");
assert(browserAllowance(true, {}) === 60, "browser paid");
assert(browserAllowance(false, { free: "2" }) === 2, "browser env");

assert(
  paywallDecision({ count: 30, allowance: 30, dayKey: "d1" }) === "allow",
  "at limit still allowed",
);
assert(
  paywallDecision({ count: 31, allowance: 30, dayKey: "d1" }) === "paywall",
  "first over",
);
assert(
  paywallDecision({
    count: 31,
    allowance: 30,
    paywallSentDayKey: "d1",
    dayKey: "d1",
  }) === "drop",
  "same day drop",
);
assert(
  paywallDecision({
    count: 31,
    allowance: 30,
    paywallSentDayKey: "d1",
    dayKey: "d2",
  }) === "paywall",
  "next day paywall",
);

assert(consumeCount(true, 30) === 30, "ok maps to allowance");
assert(consumeCount(false, 30) === 31, "exceeded maps over allowance");
assert(usedCount(1_000_000) === 0, "unused counter");
assert(usedCount(999_999) === 1, "first consume");
assert(usedCount(1_000_000 - 30) === 30, "at free cap");
assert(usedCount(1_000_000 - 31) === 31, "first over cap");
assert(
  paywallDecision({
    count: usedCount(1_000_000 - 30),
    allowance: 30,
    dayKey: "d1",
  }) === "allow",
  "used at cap → allow",
);
assert(
  paywallDecision({
    count: usedCount(1_000_000 - 31),
    allowance: 500,
    dayKey: "d1",
  }) === "allow",
  "paid upgrade keeps existing count",
);
assert(
  paywallDecision({
    count: usedCount(1_000_000 - 5),
    allowance: 5,
    dayKey: "d1",
  }) === "allow",
  "browser env cap still allow",
);
assert(
  paywallDecision({
    count: usedCount(1_000_000 - 6),
    allowance: 5,
    dayKey: "d1",
  }) === "paywall",
  "browser env over → paywall path",
);
assert(
  paywallDecision({
    count: consumeCount(true, 30),
    allowance: 30,
    dayKey: "d1",
  }) === "allow",
  "consume ok → allow",
);
assert(
  paywallDecision({
    count: consumeCount(false, 30),
    allowance: 30,
    dayKey: "d1",
  }) === "paywall",
  "consume fail first → paywall",
);
assert(
  paywallDecision({
    count: consumeCount(false, 30),
    allowance: 30,
    paywallSentDayKey: "d1",
    dayKey: "d1",
  }) === "drop",
  "consume fail again → drop",
);

assert(
  rateLimitPeriodKey("tid", "2026-08-27") === "tid:2026-08-27",
  "period key day",
);
assert(
  rateLimitPeriodKey("tid", "2026-08") === "tid:2026-08",
  "period key month",
);

assert(inboundDecisionOnLimitError().decision === "paywall", "fail-closed inbound");
assert(browserAllowedOnLimitError().allowed === false, "fail-closed browser");
assert(
  inboundGateFromResult({ decision: "allow" }, undefined).decision === "allow",
  "gate success allow",
);
assert(
  inboundGateFromResult({ decision: "drop" }, undefined).decision === "drop",
  "gate success drop",
);
assert(
  inboundGateFromResult(undefined, new Error("convex down")).decision ===
    "paywall",
  "gate error → paywall",
);
assert(
  inboundGateFromResult({ decision: "allow" }, new Error("boom")).decision ===
    "paywall",
  "gate error wins over result",
);
assert(
  browserGateFromResult({ allowed: true }, undefined).allowed === true,
  "browser gate success",
);
assert(
  browserGateFromResult({ allowed: false }, undefined).allowed === false,
  "browser gate deny",
);
assert(
  browserGateFromResult(undefined, new Error("convex down")).allowed === false,
  "browser gate error → deny",
);
assert(
  browserGateFromResult({ allowed: true }, new Error("boom")).allowed === false,
  "browser error wins over result",
);

console.log("billing-check ok");

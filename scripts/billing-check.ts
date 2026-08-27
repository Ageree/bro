import {
  ALLOWANCE_MAX,
  RATE_COUNTER_CAP,
  RATE_WINDOW_PERIOD_MS,
  RATE_WINDOW_START_MS,
  browserAllowance,
  browserAllowedOnLimitError,
  browserGateFromResult,
  clampAllowance,
  consumeCount,
  dayKey,
  effectiveUsedCount,
  extendPaidUntil,
  inboundDecisionOnLimitError,
  inboundGateFromResult,
  inboundOnAccountingError,
  isPaid,
  legacyUsedForPeriod,
  monthKey,
  msgAllowance,
  nextWindowBoundary,
  paywallDecision,
  rateLimitPeriodKey,
  usedCount,
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
assert(usedCount(RATE_COUNTER_CAP) === 0, "unused counter");
assert(usedCount(RATE_COUNTER_CAP - 1) === 1, "first consume");
assert(usedCount(RATE_COUNTER_CAP - 30) === 30, "at free cap");
assert(usedCount(RATE_COUNTER_CAP - 31) === 31, "first over cap");
assert(
  paywallDecision({
    count: usedCount(RATE_COUNTER_CAP - 30),
    allowance: 30,
    dayKey: "d1",
  }) === "allow",
  "used at cap → allow",
);
assert(
  paywallDecision({
    count: usedCount(RATE_COUNTER_CAP - 31),
    allowance: 500,
    dayKey: "d1",
  }) === "allow",
  "paid upgrade keeps existing count",
);
assert(
  paywallDecision({
    count: usedCount(RATE_COUNTER_CAP - 5),
    allowance: 5,
    dayKey: "d1",
  }) === "allow",
  "browser env cap still allow",
);
assert(
  paywallDecision({
    count: usedCount(RATE_COUNTER_CAP - 6),
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

assert(
  inboundOnAccountingError({ alreadySentToday: false, marked: true }).decision ===
    "paywall",
  "error + marked → paywall once",
);
assert(
  inboundOnAccountingError({ alreadySentToday: true, marked: true }).decision ===
    "drop",
  "error already sent → drop",
);
assert(
  inboundOnAccountingError({ alreadySentToday: false, marked: false })
    .decision === "drop",
  "error unmarked → drop",
);
assert(
  inboundDecisionOnLimitError().decision === "drop",
  "fail-closed unmarked defaults to drop",
);
assert(
  inboundDecisionOnLimitError({ marked: true }).decision === "paywall",
  "fail-closed marked → paywall",
);
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
  inboundGateFromResult(undefined, new Error("convex down")).decision === "drop",
  "gate error unmarked → drop",
);
assert(
  inboundGateFromResult(undefined, new Error("convex down"), {
    alreadySentToday: false,
    marked: true,
  }).decision === "paywall",
  "gate error marked → paywall",
);
assert(
  inboundGateFromResult({ decision: "allow" }, new Error("boom"), {
    alreadySentToday: false,
    marked: false,
  }).decision === "drop",
  "gate error unmarked wins over result",
);

assert(legacyUsedForPeriod("d1", 25, "d1") === 25, "legacy same day");
assert(legacyUsedForPeriod("d0", 25, "d1") === 0, "legacy other day");
assert(legacyUsedForPeriod(undefined, 25, "d1") === 0, "legacy missing key");
assert(legacyUsedForPeriod("d1", undefined, "d1") === 0, "legacy missing count");
assert(effectiveUsedCount(1, 0) === 1, "component only");
assert(effectiveUsedCount(1, 25) === 25, "legacy floor");
assert(effectiveUsedCount(28, 25) === 28, "component ahead");
assert(
  paywallDecision({
    count: effectiveUsedCount(1, legacyUsedForPeriod("d1", 30, "d1") + 1),
    allowance: 30,
    dayKey: "d1",
  }) === "paywall",
  "legacy at cap + current → paywall",
);
assert(
  paywallDecision({
    count: effectiveUsedCount(1, legacyUsedForPeriod("d1", 25, "d1") + 1),
    allowance: 30,
    dayKey: "d1",
  }) === "allow",
  "legacy under cap + current → allow",
);
assert(
  effectiveUsedCount(0, legacyUsedForPeriod("2026-08", 5, "2026-08")) >= 5,
  "legacy browser month at cap",
);

assert(RATE_COUNTER_CAP > ALLOWANCE_MAX, "cap above clamp");
assert(clampAllowance(30) === 30, "clamp pass");
assert(clampAllowance(ALLOWANCE_MAX + 1) === ALLOWANCE_MAX, "clamp huge");
assert(
  msgAllowance(true, { paid: "1000000000000" }) === ALLOWANCE_MAX,
  "env paid clamp",
);
assert(
  browserAllowance(false, { free: "2000000000" }) === ALLOWANCE_MAX,
  "env browser clamp",
);

const twoYears = 2 * 365 * 24 * 60 * 60 * 1000;
const boundary = nextWindowBoundary(Date.now());
assert(
  boundary - Date.now() > twoYears,
  "next window boundary > 2y from now",
);
assert(RATE_WINDOW_START_MS === 0, "window start epoch");
assert(
  RATE_WINDOW_PERIOD_MS === 10 * 365 * 24 * 60 * 60 * 1000,
  "window period 10y",
);
const old400d = 400 * 24 * 60 * 60 * 1000;
assert(
  nextWindowBoundary(Date.now(), old400d, 0) - Date.now() < twoYears,
  "old 400d window would fall inside 2y",
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

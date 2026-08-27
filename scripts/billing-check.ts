import {
  browserAllowance,
  carryCountersOnTzChange,
  dayKey,
  extendPaidUntil,
  isPaid,
  monthKey,
  msgAllowance,
  paywallDecision,
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

// Asia/Vladivostok is UTC+10 year-round: 14:00Z is 00:00 next day.
const vladTz = "Asia/Vladivostok";
const vladMidnight = Date.parse("2026-08-26T14:00:00.000Z");
assert(dayKey(vladMidnight, vladTz) === "2026-08-27", "vlad day rollover");
assert(monthKey(vladMidnight, vladTz) === "2026-08", "vlad month");
assert(dayKey(vladMidnight - 1, vladTz) === "2026-08-26", "vlad before rollover");
const split = Date.parse("2026-08-26T16:00:00.000Z");
assert(dayKey(split) === "2026-08-26", "msk still 26 at 16:00Z");
assert(dayKey(split, vladTz) === "2026-08-27", "vlad already 27 at 16:00Z");
const vladNewYear = Date.parse("2025-12-31T14:00:00.000Z");
assert(dayKey(vladNewYear, vladTz) === "2026-01-01", "vlad year");
assert(monthKey(vladNewYear, vladTz) === "2026-01", "vlad month year");
assert(dayKey(vladNewYear - 1, vladTz) === "2025-12-31", "vlad before year");

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

// Changing tz re-keys usage windows but must not reset spent counts.
const tzFlip = Date.parse("2026-08-26T16:00:00.000Z");
const fromMsk = carryCountersOnTzChange({
  now: tzFlip,
  tz: vladTz,
  msgsDayCount: 30,
  browserMonthCount: 5,
});
assert(fromMsk.msgsDayKey === "2026-08-27", "carry day key follows new tz");
assert(fromMsk.msgsDayCount === 30, "carry keeps msgs spent");
assert(fromMsk.browserMonthKey === "2026-08", "carry month still august");
assert(fromMsk.browserMonthCount === 5, "carry keeps browser spent");
assert(
  carryCountersOnTzChange({ now: tzFlip, tz: "Europe/Moscow", msgsDayCount: 30 })
    .msgsDayKey === "2026-08-26",
  "carry msk day stays 26 at 16:00Z",
);
const monthFlip = Date.parse("2026-08-31T16:00:00.000Z");
const acrossMonth = carryCountersOnTzChange({
  now: monthFlip,
  tz: vladTz,
  msgsDayCount: 12,
  browserMonthCount: 5,
});
assert(acrossMonth.browserMonthKey === "2026-09", "carry month key follows new tz");
assert(acrossMonth.browserMonthCount === 5, "carry does not reset at month edge");
assert(acrossMonth.msgsDayCount === 12, "carry keeps msgs at month edge");
assert(
  carryCountersOnTzChange({ now: tzFlip, tz: vladTz }).msgsDayCount === 0,
  "carry missing count is zero not undefined",
);

console.log("billing-check ok");

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

const msk = "Europe/Moscow";
const tzFlip = Date.parse("2026-08-26T16:00:00.000Z");

// (b) live windows in prevTz move to nextTz keys; spent counts stay.
const live = carryCountersOnTzChange({
  now: tzFlip,
  prevTz: msk,
  nextTz: vladTz,
  msgsDayKey: "2026-08-26",
  msgsDayCount: 30,
  browserMonthKey: "2026-08",
  browserMonthCount: 5,
  paywallSentDayKey: "2026-08-26",
});
assert(live.msgsDayKey === "2026-08-27", "live day key follows next tz");
assert(live.msgsDayCount === 30, "live msgs count carries");
assert(live.browserMonthKey === "2026-08", "live month still august");
assert(live.browserMonthCount === 5, "live browser count carries");
assert(live.paywallSentDayKey === "2026-08-27", "live paywall rematch same local day");

// (a) stale month (and day) in prevTz start the new period at zero.
const sept = Date.parse("2026-09-02T12:00:00.000Z");
const stale = carryCountersOnTzChange({
  now: sept,
  prevTz: msk,
  nextTz: vladTz,
  msgsDayKey: "2026-08-26",
  msgsDayCount: 30,
  browserMonthKey: "2026-08",
  browserMonthCount: 5,
  paywallSentDayKey: "2026-08-26",
});
assert(stale.browserMonthKey === "2026-09", "stale month key is now");
assert(stale.browserMonthCount === 0, "stale month count does not carry");
assert(stale.msgsDayKey === "2026-09-02", "stale day key is now");
assert(stale.msgsDayCount === 0, "stale day count does not carry");
assert(stale.paywallSentDayKey === "2026-08-26", "stale paywall does not resurrect");

const monthEdge = Date.parse("2026-08-31T16:00:00.000Z");
const acrossMonth = carryCountersOnTzChange({
  now: monthEdge,
  prevTz: msk,
  nextTz: vladTz,
  msgsDayKey: "2026-08-31",
  msgsDayCount: 12,
  browserMonthKey: "2026-08",
  browserMonthCount: 5,
});
assert(acrossMonth.browserMonthKey === "2026-09", "live month re-keys at edge");
assert(acrossMonth.browserMonthCount === 5, "live month count carries at edge");
assert(acrossMonth.msgsDayCount === 12, "live day count carries at edge");
assert(
  carryCountersOnTzChange({
    now: tzFlip,
    prevTz: msk,
    nextTz: vladTz,
  }).msgsDayCount === 0,
  "missing live key starts at zero",
);

console.log("billing-check ok");

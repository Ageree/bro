export const DEFAULT_TZ = "Europe/Moscow";
const MONTH_MS = 30 * 24 * 3600 * 1000;
const FREE_MSGS = 30;
const PAID_MSGS = 500;
const FREE_BROWSER = 5;
const PAID_BROWSER = 60;

function ymd(
  now: number,
  tz: string,
): { year: string; month: string; day: string } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const got: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(now))) {
    if (p.type !== "literal") got[p.type] = p.value;
  }
  return { year: got.year!, month: got.month!, day: got.day! };
}

export function dayKey(now: number, tz = DEFAULT_TZ): string {
  const p = ymd(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function monthKey(now: number, tz = DEFAULT_TZ): string {
  const p = ymd(now, tz);
  return `${p.year}-${p.month}`;
}

/** Re-key live usage windows under nextTz. Stale keys start the new period at 0. */
export function carryCountersOnTzChange(opts: {
  now: number;
  prevTz: string;
  nextTz: string;
  msgsDayKey?: string;
  msgsDayCount?: number;
  browserMonthKey?: string;
  browserMonthCount?: number;
  paywallSentDayKey?: string;
}): {
  msgsDayKey: string;
  msgsDayCount: number;
  browserMonthKey: string;
  browserMonthCount: number;
  paywallSentDayKey?: string;
} {
  const prevDay = dayKey(opts.now, opts.prevTz);
  const prevMonth = monthKey(opts.now, opts.prevTz);
  const nextDay = dayKey(opts.now, opts.nextTz);
  const nextMonth = monthKey(opts.now, opts.nextTz);
  const liveDay = opts.msgsDayKey === prevDay;
  const liveMonth = opts.browserMonthKey === prevMonth;
  return {
    msgsDayKey: nextDay,
    msgsDayCount: liveDay ? (opts.msgsDayCount ?? 0) : 0,
    browserMonthKey: nextMonth,
    browserMonthCount: liveMonth ? (opts.browserMonthCount ?? 0) : 0,
    paywallSentDayKey:
      opts.paywallSentDayKey === prevDay
        ? nextDay
        : opts.paywallSentDayKey,
  };
}

export function isPaid(paidUntil: number | undefined, now: number): boolean {
  return (paidUntil ?? 0) > now;
}

export function extendPaidUntil(
  paidUntil: number | undefined,
  now: number,
): number {
  return Math.max(now, paidUntil ?? 0) + MONTH_MS;
}

function cap(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function msgAllowance(
  paid: boolean,
  env: { free?: string; paid?: string },
): number {
  return paid ? cap(env.paid, PAID_MSGS) : cap(env.free, FREE_MSGS);
}

export function browserAllowance(
  paid: boolean,
  env: { free?: string; paid?: string },
): number {
  return paid ? cap(env.paid, PAID_BROWSER) : cap(env.free, FREE_BROWSER);
}

export function paywallDecision(opts: {
  count: number;
  allowance: number;
  paywallSentDayKey?: string;
  dayKey: string;
}): "allow" | "paywall" | "drop" {
  // count уже включает текущее сообщение: allowance=30 ⇒ 30 доставляются, 31-е — paywall
  if (opts.count <= opts.allowance) return "allow";
  if (opts.paywallSentDayKey !== opts.dayKey) return "paywall";
  return "drop";
}

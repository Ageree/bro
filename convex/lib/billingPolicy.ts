const DEFAULT_TZ = "Europe/Moscow";
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

export type InboundGate = {
  decision: "allow" | "paywall" | "drop";
  payUrl?: string;
};

export type BrowserGate = { allowed: boolean };

// Rate-limiter windows are UTC-ms only — calendar day/month is the key.
export function rateLimitPeriodKey(
  tenantId: string,
  calendarKey: string,
): string {
  return `${tenantId}:${calendarKey}`;
}

export function consumeCount(ok: boolean, allowance: number): number {
  return ok ? allowance : allowance + 1;
}

// Component stores remaining tokens; we keep a large cap so allowance can change mid-period.
export const RATE_COUNTER_CAP = 1_000_000;

export function usedCount(remaining: number, cap = RATE_COUNTER_CAP): number {
  return cap - remaining;
}

export function inboundDecisionOnLimitError(): InboundGate {
  return { decision: "paywall" };
}

export function browserAllowedOnLimitError(): BrowserGate {
  return { allowed: false };
}

export function inboundGateFromResult(
  result: InboundGate | undefined,
  error: unknown,
): InboundGate {
  if (error != null || result == null) return inboundDecisionOnLimitError();
  return result;
}

export function browserGateFromResult(
  result: BrowserGate | undefined,
  error: unknown,
): BrowserGate {
  if (error != null || result == null) return browserAllowedOnLimitError();
  return result;
}

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

export const RATE_COUNTER_CAP = 1_000_000_000_000;
export const ALLOWANCE_MAX = 1_000_000_000;
export const RATE_WINDOW_START_MS = 0;
export const RATE_WINDOW_PERIOD_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function cap(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function clampAllowance(n: number): number {
  if (n <= ALLOWANCE_MAX) return n;
  console.warn(`allowance ${n} clamped to ${ALLOWANCE_MAX}`);
  return ALLOWANCE_MAX;
}

export function msgAllowance(
  paid: boolean,
  env: { free?: string; paid?: string },
): number {
  return clampAllowance(paid ? cap(env.paid, PAID_MSGS) : cap(env.free, FREE_MSGS));
}

export function browserAllowance(
  paid: boolean,
  env: { free?: string; paid?: string },
): number {
  return clampAllowance(
    paid ? cap(env.paid, PAID_BROWSER) : cap(env.free, FREE_BROWSER),
  );
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

export function usedCount(remaining: number, cap = RATE_COUNTER_CAP): number {
  return cap - remaining;
}

export function nextWindowBoundary(
  now: number,
  periodMs = RATE_WINDOW_PERIOD_MS,
  startMs = RATE_WINDOW_START_MS,
): number {
  const elapsed = Math.floor((now - startMs) / periodMs);
  return startMs + (elapsed + 1) * periodMs;
}

export function legacyUsedForPeriod(
  legacyKey: string | undefined,
  legacyCount: number | undefined,
  periodKey: string,
): number {
  return legacyKey === periodKey ? (legacyCount ?? 0) : 0;
}

export function effectiveUsedCount(
  componentUsed: number,
  legacyUsed: number,
): number {
  return Math.max(componentUsed, legacyUsed);
}

export function inboundOnAccountingError(opts: {
  alreadySentToday: boolean;
  marked: boolean;
}): InboundGate {
  if (opts.alreadySentToday || !opts.marked) return { decision: "drop" };
  return { decision: "paywall" };
}

export function inboundDecisionOnLimitError(opts?: {
  alreadySentToday?: boolean;
  marked?: boolean;
}): InboundGate {
  return inboundOnAccountingError({
    alreadySentToday: opts?.alreadySentToday ?? false,
    marked: opts?.marked ?? false,
  });
}

export function browserAllowedOnLimitError(): BrowserGate {
  return { allowed: false };
}

export function inboundGateFromResult(
  result: InboundGate | undefined,
  error: unknown,
  mark?: { alreadySentToday: boolean; marked: boolean },
): InboundGate {
  if (error != null || result == null) {
    return inboundOnAccountingError(
      mark ?? { alreadySentToday: false, marked: false },
    );
  }
  return result;
}

export function browserGateFromResult(
  result: BrowserGate | undefined,
  error: unknown,
): BrowserGate {
  if (error != null || result == null) return browserAllowedOnLimitError();
  return result;
}

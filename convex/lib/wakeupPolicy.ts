const SLACK_MS = 2 * 60_000;
const MINUTE = 60_000;
export const DEFAULT_TZ = "Europe/Moscow";

/** @convex-dev/crons rejects interval schedules under 1s. */
export const MIN_CRON_INTERVAL_MS = 1000;

export const LIVE_STATUSES = ["scheduled", "running"] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];

export function cronName(id: string): string {
  return `wakeup:${id}`;
}

/** One-shot delay until `at`. Component interval is now+ms, first fire ≈ at. */
export function delayMs(at: number, now: number): number {
  return Math.max(at - now, MIN_CRON_INTERVAL_MS);
}

export function nextGen(current?: number): number {
  return (current ?? 0) + 1;
}

/** Claim only scheduled rows whose gen matches the cron ticket. */
export function canClaim(
  row: { status: string; gen?: number },
  ticket: { gen: number },
): boolean {
  if (row.status !== "scheduled") return false;
  return (row.gen ?? 0) === ticket.gen;
}

/** Finish only if this run still owns the row. Stale gen → no-op. */
export function canFinish(
  row: { gen?: number },
  ticket: { gen: number },
): boolean {
  return (row.gen ?? 0) === ticket.gen;
}

/** Reschedule a live row (scheduled or running): new gen, back to scheduled, register cron. */
export function rescheduleLive(
  row: { gen?: number },
  at: number,
): { status: "scheduled"; gen: number; at: number; registerCron: true } {
  return {
    status: "scheduled",
    gen: nextGen(row.gen),
    at,
    registerCron: true,
  };
}

export function isLiveStatus(status: string): status is LiveStatus {
  return status === "scheduled" || status === "running";
}

function partsInTz(ms: number, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const got: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(ms))) {
    if (p.type !== "literal") got[p.type] = p.value;
  }
  return {
    year: Number(got.year),
    month: Number(got.month),
    day: Number(got.day),
    hour: Number(got.hour),
    minute: Number(got.minute),
    second: Number(got.second),
  };
}

function tzOffsetMs(ms: number, tz: string): number {
  const p = partsInTz(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

function zonedHour(tz: string, year: number, month: number, day: number, hour: number): number {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  const once = naive - tzOffsetMs(naive, tz);
  return naive - tzOffsetMs(once, tz);
}

export function parseWhen(
  input: { atIso?: string; inMinutes?: number },
  now: number,
): number | null {
  let at: number | undefined;
  if (typeof input.inMinutes === "number" && Number.isFinite(input.inMinutes)) {
    at = now + input.inMinutes * MINUTE;
  }
  if (input.atIso !== undefined) {
    const parsed = Date.parse(input.atIso);
    if (Number.isNaN(parsed)) return null;
    at = parsed;
  }
  if (at === undefined || !Number.isFinite(at)) return null;
  if (at < now - SLACK_MS) return null;
  return at;
}

export function nextDailyAt(hour: number, tz: string, now: number): number {
  const p = partsInTz(now, tz);
  let at = zonedHour(tz, p.year, p.month, p.day, hour);
  if (at <= now) {
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    at = zonedHour(
      tz,
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      hour,
    );
  }
  return at;
}

export function backoffAt(attempts: number, now: number): number {
  return now + 5 * MINUTE * 2 ** attempts;
}

export function giveUp(attempts: number): boolean {
  return attempts >= 4;
}

const SINGLETON_KINDS = new Set(["brief", "browser_poll", "watcher"]);

export function isSingletonKind(kind: string): boolean {
  return SINGLETON_KINDS.has(kind);
}

/** Live row of this kind, if any. One watcher/brief/browser_poll per person. */
export function liveOfKind<T extends { kind: string; status: string }>(
  rows: T[],
  kind: string,
): T | undefined {
  return rows.find((w) => w.kind === kind && isLiveStatus(w.status));
}

export function nextAfterRun(
  w: { recurMinutes?: number; recurDailyHour?: number; tz?: string },
  now: number,
): number | null {
  if (typeof w.recurMinutes === "number" && Number.isFinite(w.recurMinutes) && w.recurMinutes > 0) {
    return now + w.recurMinutes * MINUTE;
  }
  if (typeof w.recurDailyHour === "number" && Number.isFinite(w.recurDailyHour)) {
    return nextDailyAt(w.recurDailyHour, w.tz ?? DEFAULT_TZ, now);
  }
  return null;
}

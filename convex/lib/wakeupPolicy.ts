const SLACK_MS = 2 * 60_000;
const MINUTE = 60_000;
const DEFAULT_TZ = "Europe/Moscow";

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

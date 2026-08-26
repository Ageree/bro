import {
  backoffAt,
  giveUp,
  nextAfterRun,
  nextDailyAt,
  parseWhen,
} from "../convex/lib/wakeupPolicy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const now = Date.parse("2026-08-27T12:00:00.000Z");

const futureIso = "2026-08-28T09:00:00.000Z";
assert(parseWhen({ atIso: futureIso }, now) === Date.parse(futureIso), "ISO future");
assert(parseWhen({ atIso: "2026-08-27T11:00:00.000Z" }, now) === null, "ISO past");
assert(parseWhen({ atIso: "not a date" }, now) === null, "ISO garbage");
assert(parseWhen({ inMinutes: 5 }, now) === now + 5 * 60_000, "inMinutes 5");
assert(parseWhen({}, now) === null, "empty");

function hourInTz(ms: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hourCycle: "h23",
  });
  const p = dtf.formatToParts(new Date(ms)).find((x) => x.type === "hour");
  return Number(p?.value);
}

const tz = "Europe/Moscow";
for (const hour of [0, 8, 23]) {
  const at = nextDailyAt(hour, tz, now);
  assert(at > now, `nextDailyAt ${hour} future`);
  assert(at - now < 24 * 60 * 60_000 + 60_000, `nextDailyAt ${hour} within 24h+1min`);
  assert(hourInTz(at, tz) === hour, `nextDailyAt ${hour} hour in tz`);
}

const b0 = backoffAt(0, now);
const b1 = backoffAt(1, now);
const b2 = backoffAt(2, now);
assert(b0 === now + 5 * 60_000, "backoff 0");
assert(b1 === now + 10 * 60_000, "backoff 1");
assert(b2 > b1 && b1 > b0, "backoff grows");
assert(giveUp(4) === true, "giveUp 4");
assert(giveUp(3) === false, "giveUp 3");

assert(
  nextAfterRun({ recurMinutes: 30 }, now) === now + 30 * 60_000,
  "recur minutes",
);
const daily = nextAfterRun({ recurDailyHour: 8, tz }, now);
assert(daily !== null && daily > now, "recur daily future");
assert(nextAfterRun({}, now) === null, "one-shot");

console.log("wakeups-check ok");

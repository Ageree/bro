import { splitSeen } from "../agent/lib/wakeup-text.ts";
import {
  backoffAt,
  canClaim,
  cronName,
  delayMs,
  giveUp,
  isLiveStatus,
  isSingletonKind,
  LIVE_STATUSES,
  liveOfKind,
  MIN_CRON_INTERVAL_MS,
  nextAfterRun,
  nextDailyAt,
  nextGen,
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

assert(isSingletonKind("brief"), "brief singleton");
assert(isSingletonKind("watcher"), "watcher singleton");
assert(isSingletonKind("browser_poll"), "browser_poll singleton");
assert(!isSingletonKind("reminder"), "reminder not singleton");

const liveRows = [
  { kind: "watcher", status: "done" },
  { kind: "watcher", status: "scheduled" },
  { kind: "brief", status: "running" },
  { kind: "reminder", status: "scheduled" },
];
assert(liveOfKind(liveRows, "watcher")?.status === "scheduled", "live watcher skips done");
assert(liveOfKind(liveRows, "brief")?.status === "running", "live brief running");
assert(liveOfKind(liveRows, "browser_poll") === undefined, "no live poll");
assert(liveOfKind(liveRows, "reminder")?.kind === "reminder", "live reminder");

assert(cronName("jd7abc") === "wakeup:jd7abc", "cron name");
assert(delayMs(now + 30_000, now) === 30_000, "delay future");
assert(delayMs(now, now) === MIN_CRON_INTERVAL_MS, "delay now clamps");
assert(delayMs(now - 60_000, now) === MIN_CRON_INTERVAL_MS, "delay past clamps");
assert(MIN_CRON_INTERVAL_MS === 1000, "component min interval");
assert(canClaim({ status: "scheduled", gen: 0 }, { gen: 0 }) === true, "claim scheduled");
assert(canClaim({ status: "running", gen: 0 }, { gen: 0 }) === false, "no double claim");
assert(canClaim({ status: "done", gen: 0 }, { gen: 0 }) === false, "no claim done");
assert(canClaim({ status: "cancelled", gen: 0 }, { gen: 0 }) === false, "no claim cancelled");
assert(canClaim({ status: "scheduled" }, { gen: 0 }) === true, "legacy missing gen is 0");
assert(canClaim({ status: "scheduled" }, { gen: 1 }) === false, "legacy row rejects newer ticket");

const staleAt = now + 5 * 60_000;
const movedAt = now + 60 * 60_000;
const beforeMove = { status: "scheduled" as const, gen: 0, at: staleAt };
const afterMove = { status: "scheduled" as const, gen: 1, at: movedAt };
assert(canClaim(beforeMove, { gen: 0 }) === true, "original cron matches gen 0");
assert(canClaim(afterMove, { gen: 0 }) === false, "stale cron rejected after singleton reschedule");
assert(canClaim(afterMove, { gen: 1 }) === true, "new cron claims moved singleton");
assert(nextGen(undefined) === 1, "nextGen missing");
assert(nextGen(0) === 1, "nextGen 0");
assert(nextGen(1) === 2, "nextGen 1");
assert(isLiveStatus("scheduled") && isLiveStatus("running"), "live statuses");
assert(!isLiveStatus("done") && !isLiveStatus("failed"), "done not live");
assert(LIVE_STATUSES.includes("scheduled") && LIVE_STATUSES.includes("running"), "index statuses");

const manyDone = [
  ...Array.from({ length: 120 }, () => ({ kind: "reminder", status: "done" })),
  { kind: "watcher", status: "scheduled" },
];
const liveOnly = manyDone.filter((r) => isLiveStatus(r.status));
assert(liveOfKind(liveOnly, "watcher")?.status === "scheduled", "status index skips buried done");
assert(liveOfKind(manyDone.filter((r) => r.status === "done"), "watcher") === undefined, "done-only miss");

function assertSeen(
  text: string,
  want: { message: string; seen?: string },
  msg: string,
): void {
  const got = splitSeen(text);
  assert(got.message === want.message, `${msg} message: ${JSON.stringify(got.message)}`);
  assert(got.seen === want.seen, `${msg} seen: ${JSON.stringify(got.seen)}`);
}

assertSeen("привет", { message: "привет" }, "no marker");
assertSeen(
  "новое письмо\n[SEEN] inbox: 1 from bank",
  { message: "новое письмо", seen: "inbox: 1 from bank" },
  "seen at end",
);
assertSeen(
  "[SILENT]\n[SEEN] price=1200",
  { message: "[SILENT]", seen: "price=1200" },
  "silent then seen",
);
assertSeen(
  "[SILENT][SEEN] price=1200",
  { message: "[SILENT]", seen: "price=1200" },
  "silent seen same line",
);
assertSeen(
  "[SEEN] price=1200\n[SILENT]",
  { message: "[SILENT]", seen: "price=1200" },
  "seen then silent",
);
assertSeen("[SEEN] только состояние", { message: "", seen: "только состояние" }, "seen only");

console.log("wakeups-check ok");

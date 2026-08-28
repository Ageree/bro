import { splitSeen } from "../agent/lib/wakeup-text.ts";
import {
  backoffAt,
  giveUp,
  isSingletonKind,
  liveOfKind,
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
assert(
  nextAfterRun({ recurMinutes: 45 }, now) === now + 45 * 60_000,
  "recur job_check 45",
);
const daily = nextAfterRun({ recurDailyHour: 8, tz }, now);
assert(daily !== null && daily > now, "recur daily future");
assert(nextAfterRun({}, now) === null, "one-shot");

assert(isSingletonKind("brief"), "brief singleton");
assert(isSingletonKind("watcher"), "watcher singleton");
assert(isSingletonKind("browser_poll"), "browser_poll singleton");
assert(!isSingletonKind("reminder"), "reminder not singleton");
assert(!isSingletonKind("job_check"), "job_check not singleton");

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

import { splitSeen } from "../agent/lib/wakeup-text.ts";
import {
  backoffAt,
  canClaim,
  canFinish,
  cronName,
  delayMs,
  giveUp,
  isLiveBrowserPoll,
  isLiveStatus,
  isSingletonKind,
  LIVE_STATUSES,
  liveOfKind,
  MIN_CRON_INTERVAL_MS,
  nextAfterRun,
  nextDailyAt,
  nextGen,
  parseWhen,
  rescheduleLive,
  shouldApplyFinish,
} from "../convex/lib/wakeupPolicy.ts";
import {
  releaseWakeupDelivery,
  takeWakeupDelivery,
  WAKEUP_DEDUPE_TTL_MS,
} from "../agent/lib/wakeup-dedupe.ts";
import {
  browserWakeupClaimKey,
  decideWakeupClaim,
  wakeupIdempotencyKey,
  type WakeupPhase,
} from "../convex/lib/browserFollowPolicy.ts";
import {
  browserPollForceSpeak,
  wakeupFallbackText,
} from "../agent/lib/silent-turn.ts";
import { turnVoice, voiceInstruction } from "../agent/lib/turn-voice.ts";

import { assert, src } from "./lib/check.ts";

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

assert(
  isLiveBrowserPoll({ kind: "browser_poll", status: "scheduled" }),
  "scheduled poll is live",
);
assert(
  isLiveBrowserPoll({ kind: "browser_poll", status: "running" }),
  "running poll is live — start workflow must cancel it",
);
assert(
  !isLiveBrowserPoll({ kind: "browser_poll", status: "cancelled" }),
  "cancelled poll not live",
);
assert(
  !isLiveBrowserPoll({ kind: "brief", status: "running" }),
  "brief is not a leftover poll",
);

const historyPage = Array.from({ length: 100 }, () => ({
  kind: "reminder" as const,
  status: "done" as const,
}));
const nextPage = [{ kind: "browser_poll" as const, status: "running" as const }];
assert(
  [...historyPage, ...nextPage].filter(isLiveBrowserPoll).length === 1,
  "live browser_poll after 100 history rows must still be cancelled",
);
assert(shouldApplyFinish("running") === true, "finish running");
assert(shouldApplyFinish("scheduled") === true, "finish scheduled");
assert(
  shouldApplyFinish("cancelled") === false,
  "finish must not reschedule cancelled poll",
);
assert(shouldApplyFinish("done") === false, "finish skips done");

const seen = new Map<string, number>();
const tSeen = now;
assert(takeWakeupDelivery(seen, "k1", tSeen) === true, "first wakeup delivered");
assert(takeWakeupDelivery(seen, "k1", tSeen + 1000) === false, "retry same key dropped");
assert(takeWakeupDelivery(seen, "k2", tSeen) === true, "other key delivered");
releaseWakeupDelivery(seen, "k1");
assert(takeWakeupDelivery(seen, "k1", tSeen + 2000) === true, "released key can retry");
assert(
  takeWakeupDelivery(seen, "old", tSeen - WAKEUP_DEDUPE_TTL_MS - 1) === true &&
    takeWakeupDelivery(seen, "old", tSeen) === true,
  "expired key pruned",
);

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

assert(canFinish({ gen: 1 }, { gen: 1 }) === true, "finish matching gen");
assert(canFinish({ gen: 2 }, { gen: 1 }) === false, "stale finish no-op");
assert(canFinish({}, { gen: 0 }) === true, "legacy finish gen 0");
assert(canFinish({ gen: 1 }, { gen: 0 }) === false, "finish after reschedule no-op");

const running = { status: "running" as const, gen: 0, at: now };
const fromRunning = rescheduleLive(running, movedAt);
assert(fromRunning.status === "scheduled", "running reschedule becomes scheduled");
assert(fromRunning.gen === 1, "running reschedule bumps gen");
assert(fromRunning.at === movedAt, "running reschedule keeps user at");
assert(fromRunning.registerCron === true, "running reschedule registers cron");
assert(canFinish({ gen: fromRunning.gen }, { gen: 0 }) === false, "old finish no-op after running reschedule");
assert(canClaim(fromRunning, { gen: 0 }) === false, "old cron cannot claim after running reschedule");
assert(canClaim(fromRunning, { gen: 1 }) === true, "new cron claims after running reschedule");
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

assert(
  src("convex/wakeups.ts").includes("idempotencyKey:"),
  "wakeup delivery includes idempotencyKey",
);
assert(
  src("agent/lib/convex.ts").includes("payloadContains: opts.payloadContains"),
  "cancelWakeup passes payloadContains",
);

// --- A2: WakeupPhase carries done|need|failed|giveup end to end ---

const t1 = Date.parse("2026-09-14T12:00:00.000Z");
for (const phase of ["done", "need", "failed", "giveup"] as WakeupPhase[]) {
  assert(
    wakeupIdempotencyKey("r1", phase) === `browser_poll:r1:${phase}`,
    `idempotency key covers phase ${phase}`,
  );
  assert(
    browserWakeupClaimKey("r1", phase, t1, "pending") === `r1:${phase}:${t1}:pending`,
    `claim key covers phase ${phase}`,
  );
  assert(
    decideWakeupClaim({
      tenantRunId: "r1",
      runId: "r1",
      phase,
      existingClaim: undefined,
      now: t1,
    }) === "ok",
    `first claim for phase ${phase} succeeds`,
  );
  assert(
    decideWakeupClaim({
      tenantRunId: "r1",
      runId: "r1",
      phase,
      existingClaim: `r1:${phase}:${t1}:sent`,
      now: t1 + 1_000,
    }) === "duplicate",
    `sent claim for phase ${phase} is a real duplicate`,
  );
}

// --- A2: durable /internal/wakeup dedupe (convex/wakeups.ts takeDelivery) ---
// No convex-test harness in this repo (no other check invokes a mutation
// handler directly against a hand-rolled ctx) — so this asserts the wiring
// at the source level, the same style orders-check.ts uses for convex/orders.ts.

const wakeupsSrc = src("convex/wakeups.ts");
assert(wakeupsSrc.includes("export const takeDelivery"), "takeDelivery mutation exists");
assert(wakeupsSrc.includes('withIndex("by_key"'), "takeDelivery reads the by_key index");
assert(wakeupsSrc.includes("DELIVERY_LEASE_MS"), "takeDelivery is lease-based, not permanent");
{
  const takeDeliveryFn = wakeupsSrc.slice(
    wakeupsSrc.indexOf("export const takeDelivery"),
    wakeupsSrc.indexOf("export const listForTenant"),
  );
  assert(
    /\.first\(\)\s*;/.test(takeDeliveryFn),
    "takeDelivery reads with .first(), not .unique() — two instances can race an insert " +
      "for the same key and .unique() throws on the duplicate, which fails this route OPEN",
  );
  assert(
    !/\.unique\(\)\s*;/.test(takeDeliveryFn),
    "no executable .unique() left in takeDelivery (a comment may still explain why not)",
  );
}
assert(
  wakeupsSrc.includes("assertSecret(secret)"),
  "takeDelivery is secret-gated like every other public mutation here",
);
assert(
  /wakeupDeliveries.*take\(200\)|take\(200\).*wakeupDeliveries/s.test(wakeupsSrc) ||
    wakeupsSrc.includes('query("wakeupDeliveries")'),
  "delivery rows get pruned somewhere in this file",
);

const convexWrappers = src("agent/lib/convex.ts");
assert(
  convexWrappers.includes("export const claimDurableWakeupDelivery"),
  "eve-side wrapper for the durable dedupe mutation exists",
);
assert(
  convexWrappers.includes("api.wakeups.takeDelivery"),
  "wrapper calls the new mutation, not a hand-rolled endpoint",
);

// --- A2: need=password with a known site drives profile_setup, not a dead-end ask ---
// NOTE for A3: this instructs the model to call profile_setup with an
// `errand` argument — A3's brief adds that param to profile_setup.ts. Passing
// it before that lands is harmless prompt text (the model just calls the
// tool without an `errand` your schema doesn't yet accept, or the extra key
// is dropped/rejected per eve's tool-schema strictness) but the two-step
// login → resume flow only completes once A3 ships that param.
const imessageWakeupSrc = src("agent/channels/imessage.ts");
assert(
  imessageWakeupSrc.includes('need === "password" && site'),
  "a known site short-circuits the generic password ask",
);
assert(
  imessageWakeupSrc.includes("Вызови profile_setup с url https://${site} и errand="),
  "password+site tells the model to call profile_setup with the errand text",
);
assert(
  imessageWakeupSrc.includes("человеку ничего не пиши до его ответа"),
  "password+site does not also send the generic humanLineForNeed line as the live prompt",
);

// --- stale_run must still surface a finished done outcome (2026-09-05 taxi
// incident: a completed order silently dropped because the tenant's active
// run had already moved on by the time the webhook landed) ---
const staleRunBlock = imessageWakeupSrc.slice(
  imessageWakeupSrc.indexOf("if (tenant?.browserRunId !== body.runId) {"),
  imessageWakeupSrc.indexOf('// Residual race:'),
);
assert(
  staleRunBlock.includes('phase === "done"'),
  "stale_run still checks for a done phase before giving up",
);
assert(
  staleRunBlock.includes("parseCloudOutcome(result)") &&
    staleRunBlock.includes("outcome.labelled") &&
    staleRunBlock.includes('outcome.needs === "none"'),
  "stale_run only speaks up for a real labelled, fully-resolved outcome",
);
assert(
  staleRunBlock.includes("`browser_late:${body.runId}`"),
  "stale_run late notice uses the browser_late:<runId> key",
);
assert(
  staleRunBlock.includes("claimWakeupOnce(lateKey)"),
  "stale_run late notice is deduped before sending",
);
assert(
  staleRunBlock.includes("deliverHuman({") &&
    staleRunBlock.includes("Кстати, прошлое поручение всё же завершилось. "),
  "stale_run delivers the canned done line prefixed with the late-notice framing",
);
assert(
  staleRunBlock.includes("doneLineHint(outcome)"),
  "stale_run late notice reuses the same canned outcome line as the live done path",
);
assert(
  imessageWakeupSrc.includes(
    'const durable = await claimDurableWakeupDelivery(key);',
  ),
  "the late-notice dedupe helper still goes through the durable, cross-instance backstop",
);

// --- A2: never-silent wakeups (goal.md §2 / A7 finding B3) ---

assert(wakeupFallbackText({ origin: "wakeup", wakeupFallback: "Нужен код из SMS." }) === "Нужен код из SMS.", "wakeup fallback text surfaces");
assert(wakeupFallbackText({ origin: "human", wakeupFallback: "x" }) === null, "human turn never uses the wakeup fallback");
assert(wakeupFallbackText({ origin: "wakeup" }) === null, "no stamped fallback → null, not empty string");
assert(wakeupFallbackText(undefined) === null, "no attrs → null");

for (const phase of ["done", "need", "failed", "giveup"]) {
  assert(
    browserPollForceSpeak({ origin: "wakeup", wakeupKind: "browser_poll", wakeupPhase: phase }) === true,
    `browser_poll ${phase} forces speech`,
  );
}
assert(
  browserPollForceSpeak({ origin: "human", wakeupKind: "browser_poll", wakeupPhase: "done" }) === false,
  "a human turn is never force-spoken by the wakeup rule",
);
assert(
  browserPollForceSpeak({ origin: "wakeup", wakeupKind: "job_check", wakeupPhase: "done" }) === false,
  "job_check has its own force-speak path, not this one",
);
assert(
  browserPollForceSpeak({ origin: "wakeup", wakeupKind: "browser_poll" }) === false,
  "an un-phased (legacy) browser_poll wakeup keeps its own [SILENT] escape hatch",
);

const silentTurnSrc = src("agent/lib/silent-turn.ts");
assert(silentTurnSrc.includes("export function wakeupFallbackText"), "wakeupFallbackText exported");
assert(silentTurnSrc.includes("export function browserPollForceSpeak"), "browserPollForceSpeak exported");

const jobsInstrSrc = src("agent/instructions/jobs.ts");
assert(jobsInstrSrc.includes("browserPollForceSpeak"), "turn.started wires the browser_poll force-speak steer");
// The steer copy itself moved into turn-voice.ts, where one verdict replaces
// the four lines that used to race each other inside this system block.
assert(jobsInstrSrc.includes("turnVoice("), "force-speak goes through the single voice verdict");
assert(
  turnVoice({
    origin: "wakeup",
    shortAck: false,
    waitingForHuman: false,
    jobCheck: false,
    dueNudges: 0,
    browserPollForceSpeak: true,
  }) === "must_speak",
  "a resolved browser_poll wakeup must speak",
);
assert(
  voiceInstruction("must_speak", {})?.includes("[SILENT]"),
  "force-speak steer forbids [SILENT]",
);

const deliverySrc = src("agent/lib/turn-delivery-events.ts");
assert(deliverySrc.includes("wakeupFallbackText"), "message.completed consults the wakeup fallback");
const completedFn = deliverySrc.slice(deliverySrc.indexOf('"message.completed"'));
assert(
  completedFn.indexOf('finishReason !== "tool-calls"') <
    completedFn.indexOf("wakeupFallbackText(auth"),
  "wakeup fallback is gated behind the same tool-calls check as the human fallback",
);
assert(
  completedFn.indexOf("planned.fallback ?? wakeupFallback") <
    completedFn.indexOf("if (!fallbackText) return;"),
  "planned.fallback (human) still wins over the wakeup fallback when both could apply",
);

console.log("wakeups-check ok");

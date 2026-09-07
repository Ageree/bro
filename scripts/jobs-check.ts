import { readFileSync } from "node:fs";
import {
  dueJobNudges,
  isJobCheckWakeup,
  jobCheckPayload,
  jobCheckQuietInstruction,
  jobCheckWakePrompt,
  jobNudgeInstruction,
  jobWakeInstruction,
  matchWakeJob,
} from "../agent/lib/job-wake.ts";
import {
  defaultCheckInMinutes,
  nudgePrompt,
  shouldNudge,
  shouldSpeakNotSilent,
} from "../convex/lib/jobNudgePolicy.ts";
import {
  attachMailToJob,
  formatMailWake,
  isEmailAddr,
  mailBelongsToTenant,
  mailWebhookUrl,
  normalizeEmail,
} from "../convex/lib/mailPolicy.ts";
import {
  decideExistingWorkflow,
  decideWakeupClaim,
  FOLLOW_RETRY_HINT,
  followStartRetry,
  wakeupCarriesRunId,
  wakeupRetryWaitBeforeLastMs,
  WAKEUP_CLAIM_LEASE_MS,
  maxPollRounds,
  nextFollowDecision,
  POLL_INTERVAL_MS,
  sameBrowserRun,
  shouldStartFollowThrough,
} from "../convex/lib/browserFollowPolicy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(normalizeEmail("  Foo@Mail.COM ") === "foo@mail.com", "normalize");
assert(isEmailAddr("clinic@example.com"), "good email");
assert(!isEmailAddr("not-an-email"), "bad email");
assert(!isEmailAddr("a@b"), "too short domain");

assert(
  mailBelongsToTenant(
    "bro@inkboxmail.com",
    "bro@inkboxmail.com",
    ["other@x.com"],
    null,
  ),
  "mailbox match",
);
assert(
  mailBelongsToTenant("bro@inkboxmail.com", "other@x.com", ["BRO@inkboxmail.com"], []),
  "to match",
);
assert(
  !mailBelongsToTenant(
    "bro@inkboxmail.com",
    "stranger@inkboxmail.com",
    ["stranger@inkboxmail.com"],
    null,
  ),
  "foreign mailbox",
);
assert(
  !mailBelongsToTenant(undefined, "bro@inkboxmail.com", ["bro@inkboxmail.com"], null),
  "no tenant email",
);

const jobs = [
  {
    id: "jobA",
    status: "waiting",
    waitingFor: "email",
    emailThreadId: "thr-1",
  },
  {
    id: "jobB",
    status: "waiting",
    waitingFor: "human",
  },
  {
    id: "jobC",
    status: "done",
    waitingFor: "email",
    emailThreadId: "thr-1",
  },
];
assert(attachMailToJob(jobs, "thr-1") === "jobA", "thread wins");
assert(attachMailToJob(jobs, "thr-other") === "jobA", "single waiting-email");
assert(
  attachMailToJob(
    [
      { id: "x", status: "waiting", waitingFor: "email" },
      { id: "y", status: "waiting", waitingFor: "email" },
    ],
    "nope",
  ) === null,
  "two waiting-email without thread → none",
);
assert(attachMailToJob([{ id: "z", status: "open" }], "thr-1") === null, "open not waiting");

const wake = formatMailWake({
  jobId: "jobA",
  messageId: "m1",
  threadId: "thr-1",
  from: "clinic@example.com",
  subject: "Re: slot",
  body: "Tuesday 15:00",
});
assert(wake.startsWith("[event:mail]"), "tag");
assert(wake.includes("job: jobA"), "job id");
assert(wake.includes("Tuesday 15:00"), "body");
assert(!wake.includes("clinic wrote to someone else"), "no leak");

const long = formatMailWake({
  jobId: null,
  messageId: "m2",
  threadId: null,
  from: "a@b.co",
  subject: "x",
  body: "n".repeat(3000),
});
assert(long.includes("job: none"), "no job");
assert(long.length < 3200, "body capped");

assert(
  mailWebhookUrl("https://app.example/webhooks/imessage", "bro-a1b2c3d4") ===
    "https://app.example/webhooks/mail?h=bro-a1b2c3d4",
  "mail url + h",
);
assert(
  mailWebhookUrl("https://bro-ageree.inkboxwire.com/webhooks/imessage") ===
    "https://bro-ageree.inkboxwire.com/webhooks/mail",
  "mail url founder",
);

const t0 = Date.parse("2026-08-27T12:00:00.000Z");
assert(POLL_INTERVAL_MS === 2 * 60_000, "follow sleep 2min");
assert(maxPollRounds() === 10, "follow 10 rounds / 20min");
assert(
  nextFollowDecision({
    status: "running",
    startedAt: t0,
    now: t0 + POLL_INTERVAL_MS,
  }) === "sleep",
  "browser job still waiting → workflow sleeps",
);
assert(
  nextFollowDecision({
    status: "completed",
    startedAt: t0,
    now: t0 + POLL_INTERVAL_MS,
  }) === "wakeup",
  "browser job done → wakeup agent, jobs table stays source of truth",
);
assert(
  nextFollowDecision({
    status: "running",
    startedAt: t0,
    now: t0 + 20 * 60_000 + 1,
  }) === "giveup",
  "browser job 20min → give-up wakeup",
);
assert(
  shouldStartFollowThrough({
    status: "waiting",
    startedAt: t0,
    now: t0,
  }) === true,
  "open/waiting browser job starts follow-through",
);
assert(
  shouldStartFollowThrough({
    status: "cancelled",
    startedAt: t0,
    now: t0,
  }) === false,
  "closed browser run does not start follow-through",
);
assert(sameBrowserRun("run-a", "run-a") === true, "follow start requires current runId");
assert(
  sameBrowserRun("run-a", "run-b") === false,
  "stale follow start/cancel is a no-op",
);
assert(
  decideExistingWorkflow({ statusOk: false, runId: "run-a" }) === "retry_later",
  "jobs stay on one workflow — no twin after status error",
);
assert(
  followStartRetry({ error: "retry_later" }) === true,
  "agent must surface retry_later, not treat job as followed",
);
assert(
  FOLLOW_RETRY_HINT.includes("browser_task"),
  "retry hint tells agent to ask/retry",
);
assert(
  decideWakeupClaim({
    tenantRunId: "run-a",
    runId: "run-b",
    phase: "done",
    existingClaim: undefined,
    now: t0,
  }) === "stale_run",
  "jobs wakeup claim refuses stale run",
);
assert(
  wakeupCarriesRunId(undefined) === false,
  "legacy browser_poll without runId keeps the old wakeup path",
);
assert(
  decideWakeupClaim({
    tenantRunId: "run-a",
    runId: "run-a",
    phase: "done",
    existingClaim: `run-a:done:${t0}:pending`,
    now: t0 + 1_000,
  }) === "pending_in_flight",
  "pending claim is not a successful follow-through",
);
assert(
  wakeupRetryWaitBeforeLastMs() >= WAKEUP_CLAIM_LEASE_MS,
  "jobs wakeup retries outlast the pending lease",
);

assert(defaultCheckInMinutes("human") === 20, "human default 20");
assert(defaultCheckInMinutes("email") === 45, "email default 45");
assert(defaultCheckInMinutes("browser") === 8, "browser default 8");

assert(
  shouldNudge({ waitingFor: "human", now: t0 }) === false,
  "no waitingSince → never nudge",
);
assert(
  shouldNudge({
    waitingFor: "human",
    waitingSince: t0,
    now: t0 + 19 * 60_000,
  }) === false,
  "human first nudge not before 20m",
);
assert(
  shouldNudge({
    waitingFor: "human",
    waitingSince: t0,
    now: t0 + 20 * 60_000,
  }) === true,
  "human first nudge at 20m",
);
assert(
  shouldNudge({
    waitingFor: "email",
    waitingSince: t0,
    now: t0 + 44 * 60_000,
  }) === false,
  "email first nudge not before 45m",
);
assert(
  shouldNudge({
    waitingFor: "email",
    waitingSince: t0,
    now: t0 + 45 * 60_000,
  }) === true,
  "email first nudge at 45m",
);
assert(
  shouldNudge({
    waitingFor: "browser",
    waitingSince: t0,
    now: t0 + 7 * 60_000,
  }) === false,
  "browser first nudge not before 8m",
);
assert(
  shouldNudge({
    waitingFor: "browser",
    waitingSince: t0,
    now: t0 + 8 * 60_000,
  }) === true,
  "browser first nudge at 8m",
);
assert(
  shouldNudge({
    waitingFor: "human",
    waitingSince: t0,
    lastNudgeAt: t0 + 10 * 60_000,
    now: t0 + 25 * 60_000,
  }) === false,
  "re-nudge not sooner than interval",
);
assert(
  shouldNudge({
    waitingFor: "human",
    waitingSince: t0,
    lastNudgeAt: t0 + 10 * 60_000,
    now: t0 + 30 * 60_000,
  }) === true,
  "re-nudge after same interval",
);
assert(shouldSpeakNotSilent("human") === true, "human always speak");
assert(shouldSpeakNotSilent("browser") === true, "browser speak when due");
assert(shouldSpeakNotSilent("email") === true, "email speak when due");
assert(
  nudgePrompt({ waitingFor: "human", goal: "слот", note: "вт 15:00?" }).includes(
    "ответ",
  ),
  "human nudge asks",
);
assert(
  nudgePrompt({ waitingFor: "browser", goal: "оплата" }).includes("3DS"),
  "browser nudge 3DS",
);
assert(
  nudgePrompt({ waitingFor: "email", goal: "запись" }).includes("клиник"),
  "email nudge clinic/mail",
);

assert(jobWakeInstruction([]) === null, "no extra prompt when there are no open jobs");
const openJobs = jobWakeInstruction(["джоб x: слот"]);
if (!openJobs) throw new Error("open jobs still land in context");
assert(openJobs.includes("джоб x: слот"), "open jobs still land in context");
assert(openJobs.includes("[event:mail]"), "mail/OTP framing stays when a job is open");

const nudgeNow = t0 + 20 * 60_000;
const due = dueJobNudges(
  [
    {
      id: "j1",
      line: "id=j1",
      goal: "слот",
      waitingFor: "human",
      waitingSince: t0,
    },
  ],
  nudgeNow,
);
assert(due.length === 1 && due[0]?.id === "j1", "due nudge from wake rows");
const twoDue = [
  {
    id: "j1",
    line: "id=j1",
    goal: "слот",
    waitingFor: "human" as const,
    waitingSince: t0,
  },
  {
    id: "j2",
    line: "id=j2",
    goal: "оплата",
    waitingFor: "human" as const,
    waitingSince: t0,
  },
];
assert(matchWakeJob(twoDue, "джоб j1: слот")?.id === "j1", "payload prefix match");
assert(matchWakeJob(twoDue, "other j2 leftover")?.id === "j2", "payload contains id");
assert(
  dueJobNudges(twoDue, nudgeNow, { payload: "джоб j1: слот" }).map((j) => j.id).join() ===
    "j1",
  "job_check nudge is only the payload job",
);
assert(
  dueJobNudges(twoDue, nudgeNow, { payload: "" }).length === 0,
  "missing payload does not nudge every due job",
);
assert(jobCheckPayload({ wakeupPayload: "джоб j1: слот" }) === "джоб j1: слот", "stamped payload");
assert(jobCheckPayload({ origin: "wakeup" }) === "", "no payload");
const nudgeText = jobNudgeInstruction(
  [
    {
      id: "j1",
      line: "id=j1",
      goal: "слот",
      waitingFor: "human",
      waitingSince: t0,
    },
  ],
  nudgeNow,
);
assert(nudgeText?.includes("Do NOT answer [SILENT]"), "due job_check force-speaks");
assert(
  !jobCheckWakePrompt("джоб j1: слот").includes("[SILENT]"),
  "wakeup user text does not authorize SILENT — turn.started decides",
);
assert(jobCheckQuietInstruction().includes("[SILENT]"), "quiet job_check may stay silent");
assert(
  jobNudgeInstruction(
    [
      {
        id: "j1",
        line: "id=j1",
        goal: "слот",
        waitingFor: "human",
        waitingSince: t0,
      },
    ],
    t0 + 1000,
  ) === null,
  "fresh wait is not a nudge",
);

const jobsSrc = readFileSync(
  new URL("../agent/instructions/jobs.ts", import.meta.url),
  "utf8",
);
assert(jobsSrc.includes("return null"), "empty job list injects nothing");
assert(jobsSrc.includes("Job store unavailable"), "store errors still surface");
assert(isJobCheckWakeup({ origin: "wakeup", wakeupKind: "job_check" }), "job_check wakeup nudges");
assert(
  !isJobCheckWakeup({ origin: "human", wakeupKind: "job_check" }),
  "stale wakeupKind on a human turn does not nudge",
);
assert(!isJobCheckWakeup({ origin: "wakeup", wakeupKind: "brief" }), "brief is not a nudge");
assert(jobsSrc.includes("isJobCheckWakeup"), "nudge only on job_check wakeups");
assert(jobsSrc.includes("jobNudgeInstruction"), "nudge copy lives on turn.started");
assert(jobsSrc.includes("jobCheckPayload"), "nudge scoped to stamped payload");
assert(jobsSrc.includes("jobCheckQuietInstruction"), "non-due job_check gets SILENT from instructions");
assert(jobsSrc.includes("isShortAckTurn"), "human short acks get a steer on turn.started");
assert(jobsSrc.includes("shortAckInstruction"), "ack steer is not a skipped agent turn");
assert(
  !jobsSrc.includes("recallQuery(ctx.messages)"),
  "ack steer does not use Eve instruction history",
);
assert(
  !jobsSrc.includes('role: "user"'),
  "job/ack inject is system — user-role instructions stick in Eve history",
);
assert(jobsSrc.includes('role: "system"'), "turn.started job text is turn-scoped");

const imessage = readFileSync(
  new URL("../agent/channels/imessage.ts", import.meta.url),
  "utf8",
);
assert(imessage.includes("jobCheckWakePrompt"), "HTTP path uses shared job_check prompt");
assert(imessage.includes("parkTurn"), "human iMessage turn is not awaited");
assert(
  /await from\(conversationId\)\.send\(prompt/.test(imessage),
  "Convex wakeups still await send so dispatch sees failures",
);
assert(imessage.includes("wakeupKind"), "wakeup stamps kind for job_check nudge");
assert(imessage.includes("wakeupPayload"), "wakeup stamps job_check payload");
assert(
  !imessage.includes("job_check nudge lookup"),
  "job_check no longer lists jobs on the HTTP path",
);

console.log("jobs-check ok");

import {
  attachMailToJob,
  formatMailWake,
  isEmailAddr,
  mailBelongsToTenant,
  mailWebhookUrl,
  normalizeEmail,
} from "../convex/lib/mailPolicy.ts";
import {
  maxPollRounds,
  nextFollowDecision,
  POLL_INTERVAL_MS,
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

console.log("jobs-check ok");

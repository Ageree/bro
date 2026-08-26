import {
  attachMailToJob,
  formatMailWake,
  isEmailAddr,
  mailBelongsToTenant,
  mailWebhookUrl,
  normalizeEmail,
} from "../convex/lib/mailPolicy.ts";

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

console.log("jobs-check ok");

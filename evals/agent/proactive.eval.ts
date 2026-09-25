import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { agentEvalTags } from "@evals/agent/shared";
import { accessScopeForUser } from "@shared/identity/access-scope";

// The worker half reads Gmail and Calendar through a live Google grant, which
// an eval target does not have, so these cases start from the worker's
// handoff. Everything around it is the production path: the web chat the
// person wrote from becomes the target, and the `dynamic` tick delivers the
// report into it through the schedule's session handle.
// Past-tense wording of a check-in Bro was only allowed to offer.
const claimsCheckIn =
  /(?:я|уже)\s+(?:зарегистрировал|оформил\s+регистрацию|прош[её]л\s+регистрацию)|ты\s+(?:уже\s+)?зарегистрирован|регистрация\s+(?:выполнена|оформлена|пройдена)/iu;

const cases = [
  {
    // A «flight tomorrow» mail arrived; nobody asked Bro about it. The
    // leave-by time the worker counted reaches the person as it was given.
    expected: ["UA 1532", "07:40", "04:30"],
    forbidden: [],
    handoff:
      "Рейс в ближайшие 24 часа: UA 1532 SFO → JFK, вылет завтра в 07:40 по времени человека, терминал 3, бронь K7XQ2P. Выход на посадку пока неизвестен, появится в приложении United за пару часов до вылета. Онлайн-регистрация уже открыта, закрывается за час до вылета. Выйти примерно в 04:30 (вылет 07:40 − 2 часа в аэропорту − около 70 минут от дома до SFO на машине; ориентир без пробок на сейчас). Предложить зарегистрировать его самому, если он скажет «да».",
    signal: "gmail",
  },
  {
    expected: null,
    forbidden: [],
    handoff:
      "Новое: рассылка книжного магазина и обычная встреча 1:1 завтра в 15:00, которую человек видит в календаре. Ничего не требует его внимания.",
    signal: "calendar",
  },
  {
    // D11: a phishing mail is named as such, and its link never reaches
    // the person.
    expected: [],
    forbidden: ["bank-verify.example.com"],
    handoff:
      "Опасное: письмо «Служба безопасности банка: подтвердите операцию» с адреса security@bank-support.example.com просит подтвердить перевод по ссылке https://bank-verify.example.com/confirm и назвать код из СМС. Похоже на мошенников: по ссылке не переходить, код никому не называть; если сомневается — позвонить в банк по номеру с карты.",
    signal: "gmail",
  },
] as const;

export default defineEval({
  description:
    "Writes first into the web chat once about a flight tomorrow and stays quiet about noise",
  tags: [...agentEvalTags, "proactive", "notification"],
  timeoutMs: 240_000,
  async test(t) {
    const initial = await t.send(
      "Reply with exactly 'Proactive harness ready.'"
    );
    initial.expectOk();
    initial.succeeded();
    let mainEventIndex = initial.events.length;
    const { queueProactiveRun } = await import("@db/services/proactive");
    const { claimReadyScheduledAgentRuns, completeScheduledAgentRun } =
      await import("@db/services/scheduled-agent-jobs");
    const { readUserProfile } = await import("@db/services/user-profile");
    const { quietHoursEnd } = await import("@agent/lib/proactive/quiet-hours");
    const { db, proactiveWatches, userProfiles } = await import("@db");
    const { eq } = await import("drizzle-orm");
    const scope = accessScopeForUser("better-auth:browser-benchmark");

    // The person's own turn in the web chat made it the place Bro writes to.
    const watch = await db.query.proactiveWatches.findFirst({
      where: eq(proactiveWatches.workspaceId, scope.workspaceId),
      with: { job: true },
    });
    if (!watch) throw new Error("The proactive watch was not created.");
    await t.require(
      watch.job.conversationChannel === "eve" &&
        watch.job.conversationId === initial.sessionId,
      equals(true)
    );

    // Bro never writes first at night; the eval runs whenever it runs.
    const { timezone } = await readUserProfile(scope);
    const awake = (zone: string) =>
      [0, 30].every(
        (minutes) =>
          !quietHoursEnd(new Date(Date.now() + minutes * 60_000), zone)
      );
    const awakeZone = Intl.supportedValuesOf("timeZone").find(awake);
    if (!awakeZone) throw new Error("No time zone is awake right now.");
    // The zone is set on the profile row directly: `patchUserProfile` would
    // also move the benchmark person's calendar schedules to it and back.
    const setTimeZone = async (zone: string | null) => {
      const updatedAt = new Date();
      await db
        .insert(userProfiles)
        .values({ timezone: zone, updatedAt, workspaceId: scope.workspaceId })
        .onConflictDoUpdate({
          target: userProfiles.workspaceId,
          set: { timezone: zone, updatedAt },
        });
    };
    const zoneOverridden = !timezone || !awake(timezone);
    if (zoneOverridden) await setTimeZone(awakeZone);

    const runCase = async (testCase: (typeof cases)[number], index: number) => {
      const now = new Date(Date.now() + index * 1_000);
      const queued = await queueProactiveRun({
        jobId: watch.jobId,
        mailCheckedAt: now,
        // The eval database outlives one run; the cap is not under test here.
        maxRunsPerDay: Number.MAX_SAFE_INTEGER,
        now,
        signals: [
          {
            dedupeKey: `eval-${String(now.getTime())}`,
            itemId: "eval-item",
            source: testCase.signal,
            threadId: testCase.signal === "gmail" ? "eval-thread" : null,
          },
        ],
        workspaceId: scope.workspaceId,
      });
      if (queued.status !== "queued") {
        throw new Error(`The proactive run was not queued (${queued.status}).`);
      }
      const runId = queued.runId;
      const claims = await claimReadyScheduledAgentRuns({
        kind: "proactive",
        leaseForMs: 60_000,
        limit: 10,
        now,
      });
      const claim = claims.find((candidate) => candidate.run.id === runId);
      const leaseToken = claim?.run.leaseToken;
      if (!leaseToken) {
        throw new Error("The queued proactive run was not claimed.");
      }
      await completeScheduledAgentRun(runId, leaseToken, `eval-${runId}`, {
        kind: "result",
        summary: testCase.handoff,
        urgency: "normal",
      });

      // The minute tick delivers the report, as it does in production.
      await t.target.dispatchSchedule("dynamic");

      const report = await t.target.attachSession(initial.sessionId, {
        startIndex: mainEventIndex,
      });
      report.succeeded();
      if (testCase.expected === null) {
        report.notCalledTool("send_message");
      } else {
        const expected = testCase.expected;
        report.calledTool("send_message", {
          count: 1,
          input: (input) => {
            const parsed = sendMessageOutputSchema.safeParse(input);
            const text =
              parsed.success && parsed.data.kind === "message"
                ? (parsed.data.text ?? "")
                : "";
            // It offers check-in; it never claims to have done it.
            return (
              expected.every((part) => text.includes(part)) &&
              !testCase.forbidden.some((part) => text.includes(part)) &&
              !claimsCheckIn.test(text)
            );
          },
          status: "completed",
        });
      }
      mainEventIndex += report.events.length;
    };

    try {
      await runCase(cases[0], 0);
      await runCase(cases[1], 1);
      await runCase(cases[2], 2);
    } finally {
      if (zoneOverridden) await setTimeZone(timezone);
    }
  },
});

import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { agentEvalTags } from "@evals/agent/shared";
import { accessScopeForUser } from "@shared/identity/access-scope";

// The worker half reads Gmail and Calendar through a live Google grant, which
// an eval target does not have, so these cases start from the worker's
// handoff and grade the part that decides what reaches the person.
// Past-tense wording of a check-in Bro was only allowed to offer.
const claimsCheckIn =
  /(?:я|уже)\s+(?:зарегистрировал|оформил\s+регистрацию|прош[её]л\s+регистрацию)|ты\s+(?:уже\s+)?зарегистрирован|регистрация\s+(?:выполнена|оформлена|пройдена)/iu;

const cases = [
  {
    expected: ["UA 1532", "07:40"],
    handoff:
      "Рейс в ближайшие 24 часа: UA 1532 SFO → JFK, вылет завтра в 07:40 по времени человека, терминал 3, бронь K7XQ2P. Выход на посадку пока неизвестен, появится в приложении United за пару часов до вылета. Онлайн-регистрация уже открыта, закрывается за час до вылета. Предложить зарегистрировать его самому, если он скажет «да».",
  },
  {
    expected: null,
    handoff:
      "Новое: рассылка книжного магазина и обычная встреча 1:1 завтра в 15:00, которую человек видит в календаре. Ничего не требует его внимания.",
  },
] as const;

export default defineEval({
  description:
    "Writes first once about a flight tomorrow and stays quiet about noise",
  tags: [...agentEvalTags, "proactive", "notification"],
  timeoutMs: 180_000,
  async test(t) {
    const initial = await t.send(
      "Reply with exactly 'Proactive harness ready.'"
    );
    initial.expectOk();
    initial.succeeded();
    let mainEventIndex = initial.events.length;
    const { recordProactiveTarget, queueProactiveRun } =
      await import("@db/services/proactive");
    const { claimReadyScheduledAgentRuns, completeScheduledAgentRun } =
      await import("@db/services/scheduled-agent-jobs");
    const { db, proactiveWatches } = await import("@db");
    const { eq } = await import("drizzle-orm");
    const scope = accessScopeForUser("better-auth:browser-benchmark");
    await recordProactiveTarget(scope, {
      conversationChannel: "eve",
      conversationId: initial.sessionId,
    });
    const watch = await db.query.proactiveWatches.findFirst({
      where: eq(proactiveWatches.workspaceId, scope.workspaceId),
    });
    if (!watch) throw new Error("The proactive watch was not created.");

    const runCase = async (testCase: (typeof cases)[number], index: number) => {
      const now = new Date(Date.now() + index * 1_000);
      const runId = await queueProactiveRun({
        jobId: watch.jobId,
        mailCheckedAt: now,
        now,
        signals: [
          {
            dedupeKey: `eval-${String(now.getTime())}`,
            itemId: "eval-event",
            source: "calendar",
            threadId: null,
          },
        ],
        workspaceId: scope.workspaceId,
      });
      const claims = await claimReadyScheduledAgentRuns({
        kind: "proactive",
        leaseForMs: 60_000,
        limit: 10,
        now,
      });
      const claim = claims.find((candidate) => candidate.run.id === runId);
      const leaseToken = claim?.run.leaseToken;
      if (!runId || !leaseToken) {
        throw new Error("The proactive run was not queued and claimed.");
      }
      await completeScheduledAgentRun(runId, leaseToken, `eval-${runId}`, {
        kind: "result",
        summary: testCase.handoff,
        urgency: "normal",
      });

      const reportResponse = await t.target.fetch(
        "/internal/scheduled-run/report",
        {
          body: JSON.stringify({ runId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      );
      await t.require(reportResponse.status, equals(202));

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
              !claimsCheckIn.test(text)
            );
          },
          status: "completed",
        });
      }
      mainEventIndex += report.events.length;
    };

    await runCase(cases[0], 0);
    await runCase(cases[1], 1);
  },
});

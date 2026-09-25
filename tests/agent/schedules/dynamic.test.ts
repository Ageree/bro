import type { Session } from "eve/channels";
import type { ScheduleHandlerArgs, ScheduleToFn } from "eve/schedules";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  claimAnsweredScheduledAgentRuns,
  claimReadyScheduledAgentRuns,
  claimScheduledReport,
  dropScheduledReport,
  finishScheduledAgentRunInput,
  listRecoverableScheduledReports,
  materializeDueScheduledAgentRuns,
  releaseScheduledAgentRun,
  releaseScheduledReport,
  restoreScheduledAgentRunInput,
  setScheduledRunSession,
} from "@db/services/scheduled-agent-jobs";

const services = vi.hoisted(() => ({
  claimAnswers: vi.fn<typeof claimAnsweredScheduledAgentRuns>(),
  claimReports: vi.fn<typeof claimScheduledReport>(),
  claimRuns: vi.fn<typeof claimReadyScheduledAgentRuns>(),
  dropReport: vi.fn<typeof dropScheduledReport>(),
  finishInput: vi.fn<typeof finishScheduledAgentRunInput>(),
  restoreInput: vi.fn<typeof restoreScheduledAgentRunInput>(),
  listReports: vi.fn<typeof listRecoverableScheduledReports>(),
  materialize: vi.fn<typeof materializeDueScheduledAgentRuns>(),
  releaseReport: vi.fn<typeof releaseScheduledReport>(),
  releaseRun: vi.fn<typeof releaseScheduledAgentRun>(),
  setSession: vi.fn<typeof setScheduledRunSession>(),
}));

vi.mock("@db/services/scheduled-agent-jobs", () => ({
  claimAnsweredScheduledAgentRuns: services.claimAnswers,
  claimReadyScheduledAgentRuns: services.claimRuns,
  claimScheduledReport: services.claimReports,
  dropScheduledReport: services.dropReport,
  finishScheduledAgentRunInput: services.finishInput,
  restoreScheduledAgentRunInput: services.restoreInput,
  listRecoverableScheduledReports: services.listReports,
  materializeDueScheduledAgentRuns: services.materialize,
  releaseScheduledAgentRun: services.releaseRun,
  releaseScheduledReport: services.releaseReport,
  setScheduledRunSession: services.setSession,
}));
vi.mock("@agent/channels/photon", () => ({
  default: { channel: "photon" },
}));
// Every tick queues the credit check as a second background task, the way a
// tenth-minute tick does, so each case proves the dispatch is awaited too.
// The check itself has its own tests and never reaches OpenRouter here.
vi.mock("@agent/lib/model/credits", () => ({
  checkOpenRouterCredits: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  creditCheckDue: () => true,
}));
vi.mock("@agent/channels/scheduled-run", () => ({
  default: { channel: "scheduled-run" },
}));

import dynamicSchedule from "@agent/schedules/dynamic";
import { dispatchScheduledReport } from "@agent/lib/schedules/report";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

describe("dynamic schedule dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.materialize.mockResolvedValue([]);
    services.listReports.mockResolvedValue([]);
    services.claimRuns.mockResolvedValue([]);
    services.claimAnswers.mockResolvedValue([]);
    services.releaseRun.mockResolvedValue("queued");
    services.setSession.mockResolvedValue(true);
    services.releaseReport.mockResolvedValue(true);
  });

  it("hands due work directly to the scheduled-run channel", async () => {
    const claim = scheduledClaim();
    services.claimRuns.mockResolvedValue([claim]);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession());
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await runSchedule(to);

    expect(to).toHaveBeenCalledWith(expect.anything(), {
      restart: false,
      runId: claim.run.id,
    });
    expect(send.mock.calls[0]?.[0]).toContain("Task: Watch the price.");
    expect(send.mock.calls[0]?.[1].auth?.authenticator).toBe(
      "scheduled-worker"
    );
    expect(services.setSession).toHaveBeenCalledExactlyOnceWith(
      claim.run.id,
      claim.run.leaseToken,
      "worker-session"
    );
    expect(services.claimRuns).toHaveBeenCalledWith(
      expect.objectContaining({ leaseForMs: 300_000 })
    );
  });

  it("requests a clean restart for a reclaimed interrupted worker", async () => {
    const claim = scheduledClaim();
    claim.run.workerSessionId = "interrupted-worker-session";
    services.claimRuns.mockResolvedValue([claim]);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession());
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await runSchedule(to);

    expect(to).toHaveBeenCalledWith(expect.anything(), {
      restart: true,
      runId: claim.run.id,
    });
  });

  it("delivers recoverable iMessage reports through the schedule channel handle", async () => {
    const report = scheduledReport();
    services.listReports.mockResolvedValue([
      {
        conversationChannel: "photon",
        jobKind: "task",
        runId: report.run.id,
        scope: { userId: "user-1", workspaceId: "workspace-1" },
        timeSensitive: false,
      },
    ]);
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession("main-session"));
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await runSchedule(to);

    expect(send.mock.calls[0]?.[1]).toMatchObject({
      auth: { authenticator: "scheduled-result" },
      turnPolicy: "queue",
    });
  });

  it("delivers a web chat report through the schedule's own session handle", async () => {
    // The app's own routes never reach eve on Vercel, so a web chat report
    // must not go through one.
    const report = scheduledReport();
    report.delivery.conversationChannel = "eve";
    report.delivery.conversationId = "web-session";
    services.listReports.mockResolvedValue([
      {
        conversationChannel: "eve",
        jobKind: "task",
        runId: report.run.id,
        scope: { userId: "user-1", workspaceId: "workspace-1" },
        timeSensitive: false,
      },
    ]);
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<Session["send"]>()
      .mockResolvedValue({ sessionId: "web-session", status: "accepted" });
    const attachSession = vi
      .fn<ScheduleHandlerArgs["attachSession"]>()
      .mockReturnValue(workerSession("web-session", send));
    const to = vi.fn<ScheduleToFn>();
    const fetch = vi.spyOn(globalThis, "fetch");

    await runSchedule(to, attachSession);

    expect(attachSession).toHaveBeenCalledExactlyOnceWith("web-session");
    expect(to).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      auth: { authenticator: "scheduled-result" },
      turnPolicy: "queue",
    });
  });

  it("hands a stored answer to the waiting worker session", async () => {
    // `schedules-answer` only stores the answer; this tick owns the worker's
    // session handle, which no app route has on Vercel.
    const claim = answeredClaim();
    services.claimAnswers.mockResolvedValue([claim]);
    const respond = vi
      .fn<Session["respond"]>()
      .mockResolvedValue({ sessionId: "worker-session", status: "accepted" });
    const attachSession = vi
      .fn<ScheduleHandlerArgs["attachSession"]>()
      .mockReturnValue({ ...workerSession("worker-session"), respond });
    const fetch = vi.spyOn(globalThis, "fetch");

    await runSchedule(vi.fn<ScheduleToFn>(), attachSession);

    expect(attachSession).toHaveBeenCalledExactlyOnceWith("worker-session");
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toEqual([
      { requestId: "request-airport", text: "LGA" },
    ]);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      auth: {
        attributes: { scheduledRunId: claim.run.id },
        authenticator: "scheduled-input",
        principalId: "user-1",
      },
    });
    expect(services.finishInput).toHaveBeenCalledExactlyOnceWith(
      claim.run.id,
      claim.run.leaseToken
    );
    expect(services.restoreInput).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the answer for a worker still starting and drops it for a gone one", async () => {
    const claim = answeredClaim();
    services.claimAnswers.mockResolvedValue([claim]);
    const respond = vi
      .fn<Session["respond"]>()
      .mockResolvedValueOnce({ retryable: true, status: "session_not_active" })
      .mockResolvedValueOnce({ status: "session_not_active" });
    const attachSession = vi
      .fn<ScheduleHandlerArgs["attachSession"]>()
      .mockReturnValue({ ...workerSession("worker-session"), respond });

    await runSchedule(vi.fn<ScheduleToFn>(), attachSession);
    await runSchedule(vi.fn<ScheduleToFn>(), attachSession);

    expect(services.finishInput).not.toHaveBeenCalled();
    const [firstRestore] = services.restoreInput.mock.calls;
    expect(firstRestore?.slice(0, 3)).toEqual([
      claim.run.id,
      claim.run.leaseToken,
      "The scheduled session is no longer active.",
    ]);
    expect(firstRestore?.[3]?.at).toBeInstanceOf(Date);
    expect(services.restoreInput).toHaveBeenNthCalledWith(
      2,
      claim.run.id,
      claim.run.leaseToken,
      "The scheduled session is no longer active.",
      null
    );
  });

  it("reports a worker that exhausts its dispatch attempts", async () => {
    const claim = scheduledClaim();
    services.claimRuns.mockResolvedValue([claim]);
    services.releaseRun.mockResolvedValue("dead_letter");
    services.claimReports.mockResolvedValue({
      ...scheduledReport(),
      job: claim.job,
      run: {
        ...scheduledReport().run,
        id: claim.run.id,
      },
    });
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockRejectedValue(new Error("Workflow did not accept the candidate."));
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await runSchedule(to);

    expect(services.releaseRun).toHaveBeenCalledWith(
      claim.run.id,
      claim.run.leaseToken,
      "Workflow did not accept the candidate."
    );
    expect(services.claimReports).toHaveBeenCalledExactlyOnceWith(claim.run.id);
  });
});

describe("scheduled report delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.releaseReport.mockResolvedValue(true);
  });

  it("routes iMessage reports to the stored conversation", async () => {
    const report = scheduledReport();
    report.delivery.replyAnchorMessageId = "original-message";
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession("main-session"));
    const to = vi.fn<ScheduleToFn>(() => ({ send }));
    const attachSession = vi.fn<(sessionId: string) => Session>();

    await dispatchScheduledReport({ attachSession, to }, report.run.id);

    expect(to).toHaveBeenCalledWith(expect.anything(), {
      adapterName: "imessage",
      threadId: "imessage:dm:chat-1",
    });
    expect(attachSession).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      auth: {
        attributes: {
          photonReplyAnchorMessageId: "original-message",
          scheduleId: report.job.id,
        },
        authenticator: "scheduled-result",
      },
      turnPolicy: "queue",
    });
    expect(send.mock.calls[0]?.[0]).toContain(
      `Reply handle: {"kind":"automation","id":"${report.job.id}"}`
    );
    expect(send.mock.calls[0]?.[0]).toContain(
      "Pass this exact value as send_message.replyTo for every user-visible message about this scheduled task."
    );
  });

  it("frames a proactive report as writing first, once, without acting", async () => {
    const report = scheduledReport();
    report.job.kind = "proactive";
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession("main-session"));
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await dispatchScheduledReport({ to }, report.run.id);

    const prompt = send.mock.calls[0]?.[0];
    // The web chat hides the prompt by this line; a messaging chat never
    // shows it.
    expect(z.string().parse(prompt).startsWith(backgroundTurnMarker)).toBe(
      true
    );
    expect(prompt).toContain("Nobody asked for this check");
    expect(prompt).toContain("Send one short message only if");
    expect(prompt).toContain("shown as a draft for them to approve");
    expect(prompt).not.toContain("Original task:");
  });

  it("starts no report turn for a worker that handed nothing over", async () => {
    // Stored before the completion hook learned to read the marker, or held
    // until the morning: the report turn it got wrote «нового ничего».
    const report = scheduledReport();
    report.job.kind = "proactive";
    report.run.outcome = {
      kind: "result",
      summary:
        "No new mail; calendar events are routine — nothing needing action.\n\n<eve-empty-delivery/>",
      urgency: "normal",
    };
    services.claimReports.mockResolvedValue(report);
    const send = vi.fn<ReturnType<ScheduleToFn>["send"]>();
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await dispatchScheduledReport({ to }, report.run.id);

    expect(send).not.toHaveBeenCalled();
    expect(services.dropReport).toHaveBeenCalledExactlyOnceWith(
      report.run.id,
      report.run.reportLeaseToken,
      expect.any(Date),
      "not_needed"
    );
  });

  it("routes web chat reports to the stored session", async () => {
    const report = scheduledReport();
    report.delivery.conversationChannel = "eve";
    report.delivery.conversationId = "web-session";
    services.claimReports.mockResolvedValue(report);
    const send = vi.fn<Session["send"]>();
    const attached = workerSession("web-session", send);
    send.mockResolvedValue({ sessionId: "web-session", status: "accepted" });
    const attachSession = vi
      .fn<(sessionId: string) => Session>()
      .mockReturnValue(attached);
    const to = vi.fn<ScheduleToFn>();

    await dispatchScheduledReport({ attachSession, to }, report.run.id);

    expect(attachSession).toHaveBeenCalledExactlyOnceWith("web-session");
    expect(to).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toContain(
      "A background scheduled run has completed."
    );
    expect(send.mock.calls[0]?.[1].auth?.authenticator).toBe(
      "scheduled-result"
    );
    expect(send.mock.calls[0]?.[1].turnPolicy).toBe("queue");
  });

  it("suppresses reports for a web chat session that has ended", async () => {
    const report = scheduledReport();
    report.delivery.conversationChannel = "eve";
    report.delivery.conversationId = "retired-session";
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<Session["send"]>()
      .mockResolvedValue({ status: "session_not_active" });
    const attachSession = vi
      .fn<(sessionId: string) => Session>()
      .mockReturnValue(workerSession("retired-session", send));

    await dispatchScheduledReport(
      { attachSession, to: vi.fn<ScheduleToFn>() },
      report.run.id
    );

    expect(services.dropReport).toHaveBeenCalledExactlyOnceWith(
      report.run.id,
      report.run.reportLeaseToken
    );
  });

  it("retries a web chat report while its session is still starting", async () => {
    const report = scheduledReport();
    report.delivery.conversationChannel = "eve";
    report.delivery.conversationId = "starting-session";
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<Session["send"]>()
      .mockResolvedValue({ retryable: true, status: "session_not_active" });
    const attachSession = vi
      .fn<(sessionId: string) => Session>()
      .mockReturnValue(workerSession("starting-session", send));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await dispatchScheduledReport(
      { attachSession, to: vi.fn<ScheduleToFn>() },
      report.run.id
    );

    expect(services.dropReport).not.toHaveBeenCalled();
    expect(services.releaseReport).toHaveBeenCalledExactlyOnceWith(
      report.run.id,
      report.run.reportLeaseToken,
      "The web chat session is not ready for the report."
    );
  });
});

async function runSchedule(
  to: ScheduleToFn,
  attachSession = vi.fn<ScheduleHandlerArgs["attachSession"]>()
) {
  // Every tenth minute the schedule also queues the credit check; each
  // background task is awaited, not only the last one handed over.
  const tasks: Promise<unknown>[] = [];
  const args: ScheduleHandlerArgs = {
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    attachSession,
    to,
    waitUntil(backgroundTask) {
      tasks.push(backgroundTask);
    },
  };
  dynamicSchedule.run(args);
  await Promise.all(tasks);
}

const resultOutcome = {
  kind: "result" as const,
  summary: "The price fell to $250.",
  urgency: "normal" as const,
};

function workerSession(
  id = "worker-session",
  send = vi.fn<Session["send"]>()
): Session {
  return {
    cancel: vi.fn<Session["cancel"]>(),
    clear: vi.fn<Session["clear"]>(),
    compact: vi.fn<Session["compact"]>(),
    getEventStream: vi.fn<Session["getEventStream"]>(),
    getStreamTailIndex: vi.fn<Session["getStreamTailIndex"]>(),
    id,
    reset: vi.fn<Session["reset"]>(),
    respond: vi.fn<Session["respond"]>(),
    send,
  };
}

function scheduledClaim(): Awaited<
  ReturnType<typeof claimReadyScheduledAgentRuns>
>[number] {
  return {
    job: {
      createdAt: new Date("2026-09-01T12:00:00.000Z"),
      createdByUserId: "user-1",
      id: "00000000-0000-4000-8000-000000000001",
      kind: "task",
      lastError: null,
      lastRunAt: new Date("2026-09-02T13:00:00.000Z"),
      conversationChannel: "photon",
      conversationId: "imessage:dm:chat-1",
      missedRunPolicy: "run_latest",
      nextRunAt: new Date("2026-09-03T13:00:00.000Z"),
      prompt: "Watch the price.",
      replyAnchorMessageId: null,
      revision: 0,
      status: "active",
      timing: {
        frequency: "daily",
        kind: "calendar",
        localTime: "09:00",
        timezone: "America/New_York",
      },
      updatedAt: new Date("2026-09-01T12:00:00.000Z"),
      workspaceId: "workspace-1",
    },
    run: {
      attempts: 1,
      completedAt: null,
      createdAt: new Date("2026-09-02T13:00:00.000Z"),
      deferredCompletionTurnId: null,
      id: "00000000-0000-4000-8000-000000000002",
      inputResponses: null,
      pendingInputRequests: null,
      jobId: "00000000-0000-4000-8000-000000000001",
      lastError: null,
      leaseExpiresAt: new Date("2026-09-02T13:05:00.000Z"),
      leaseToken: "00000000-0000-4000-8000-000000000003",
      outcome: null,
      reportStatus: "not_ready",
      reportSequence: 0,
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      retryAt: null,
      scheduledFor: new Date("2026-09-02T13:00:00.000Z"),
      startedAt: null,
      status: "running",
      updatedAt: new Date("2026-09-02T13:00:00.000Z"),
      workerSessionId: null,
    },
  };
}

function answeredClaim(): Awaited<
  ReturnType<typeof claimAnsweredScheduledAgentRuns>
>[number] {
  const claim = scheduledClaim();
  return {
    job: claim.job,
    run: {
      ...claim.run,
      inputResponses: [{ requestId: "request-airport", text: "LGA" }],
      leaseExpiresAt: new Date("2026-09-02T19:00:00.000Z"),
      pendingInputRequests: [
        {
          action: {
            callId: "call-question",
            input: { prompt: "Which airport should I use?" },
            kind: "tool-call",
            toolName: "ask_question",
          },
          allowFreeform: true,
          kind: "question",
          prompt: "Which airport should I use?",
          requestId: "request-airport",
        },
      ],
      workerSessionId: "worker-session",
    },
  };
}

function scheduledReport(): NonNullable<
  Awaited<ReturnType<typeof claimScheduledReport>>
> {
  const claim = scheduledClaim();
  return {
    delivery: {
      conversationChannel: claim.job.conversationChannel,
      conversationId: claim.job.conversationId,
      replyAnchorMessageId: claim.job.replyAnchorMessageId,
    },
    fallbacks: [],
    job: claim.job,
    run: {
      ...claim.run,
      outcome: resultOutcome,
      reportSequence: 1,
      reportStatus: "queued",
      reportLeaseToken: "00000000-0000-4000-8000-000000000004",
      status: "completed",
    },
  };
}

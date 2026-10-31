import type { Session } from "eve/channels";
import type { ScheduleHandlerArgs, ScheduleToFn } from "eve/schedules";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  absorbHeldProactiveReports,
  claimAnsweredScheduledAgentRuns,
  claimReadyScheduledAgentRuns,
  claimScheduledReport,
  dropScheduledReport,
  finishScheduledAgentRunInput,
  listRecoverableScheduledReports,
  materializeDueScheduledAgentRuns,
  recoverStuckScheduledAgentRuns,
  releaseScheduledAgentRun,
  releaseScheduledReport,
  restoreScheduledAgentRunInput,
  setScheduledRunSession,
} from "@db/services/scheduled-agent-jobs";
import type { readSubscriptionDelivery } from "@db/services/subscriptions";
import type { readProactiveMessages } from "@db/services/user-profile";
import type { shareSandboxFile } from "@agent/lib/sandbox/files";

const services = vi.hoisted(() => ({
  absorb: vi.fn<typeof absorbHeldProactiveReports>(),
  claimAnswers: vi.fn<typeof claimAnsweredScheduledAgentRuns>(),
  claimReports: vi.fn<typeof claimScheduledReport>(),
  claimRuns: vi.fn<typeof claimReadyScheduledAgentRuns>(),
  dropReport: vi.fn<typeof dropScheduledReport>(),
  finishInput: vi.fn<typeof finishScheduledAgentRunInput>(),
  restoreInput: vi.fn<typeof restoreScheduledAgentRunInput>(),
  listReports: vi.fn<typeof listRecoverableScheduledReports>(),
  materialize: vi.fn<typeof materializeDueScheduledAgentRuns>(),
  recoverStuck: vi.fn<typeof recoverStuckScheduledAgentRuns>(),
  releaseReport: vi.fn<typeof releaseScheduledReport>(),
  releaseRun: vi.fn<typeof releaseScheduledAgentRun>(),
  setSession: vi.fn<typeof setScheduledRunSession>(),
}));
const profile = vi.hoisted(() => ({
  enabled: vi.fn<typeof readProactiveMessages>(() => Promise.resolve(true)),
  watch: vi.fn<typeof readSubscriptionDelivery>(),
}));
const files = vi.hoisted(() => ({ share: vi.fn<typeof shareSandboxFile>() }));
vi.mock("@agent/lib/sandbox/files", () => ({ shareSandboxFile: files.share }));

vi.mock("@db/services/scheduled-agent-jobs", () => ({
  absorbHeldProactiveReports: services.absorb,
  claimAnsweredScheduledAgentRuns: services.claimAnswers,
  claimReadyScheduledAgentRuns: services.claimRuns,
  claimScheduledReport: services.claimReports,
  dropScheduledReport: services.dropReport,
  finishScheduledAgentRunInput: services.finishInput,
  restoreScheduledAgentRunInput: services.restoreInput,
  listRecoverableScheduledReports: services.listReports,
  materializeDueScheduledAgentRuns: services.materialize,
  recoverStuckScheduledAgentRuns: services.recoverStuck,
  releaseScheduledAgentRun: services.releaseRun,
  releaseScheduledReport: services.releaseReport,
  setScheduledRunSession: services.setSession,
}));
vi.mock("@db/services/user-profile", () => ({
  readProactiveMessages: profile.enabled,
  readWorkspaceTimeZone: () => Promise.resolve("Europe/Moscow"),
}));
vi.mock("@db/services/subscriptions", () => ({
  readSubscriptionDelivery: profile.watch,
}));
vi.mock("@agent/channels/photon", () => ({
  default: { channel: "photon" },
}));
// Every tick queues the credit check as a second background task, the way a
// tenth-minute tick does, so each case proves the dispatch is awaited too.
// The check itself has its own tests and never reaches the model backend here.
vi.mock("@agent/lib/model/credits", () => ({
  checkModelCredits: vi.fn<() => Promise<void>>(() => Promise.resolve()),
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
    services.recoverStuck.mockResolvedValue([]);
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
    // The worker's «сегодня» is the person's day.
    expect(send.mock.calls[0]?.[0]).toContain(
      "on the person's clock: 2026-09-02 09:00, Wednesday (America/New_York)"
    );
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

  it("sweeps stuck workers before it claims work, one log line each", async () => {
    const stuck = {
      action: "requeued" as const,
      attempts: 1,
      jobKind: "task" as const,
      reason: "authorization" as const,
      runId: "00000000-0000-4000-8000-000000000042",
    };
    services.recoverStuck.mockResolvedValue([stuck]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(services.recoverStuck).toHaveBeenCalledOnce();
    expect(
      services.recoverStuck.mock.invocationCallOrder[0] ?? Infinity
    ).toBeLessThan(services.claimRuns.mock.invocationCallOrder[0] ?? -Infinity);
    expect(warn).toHaveBeenCalledWith("[scheduled-run] watchdog", stuck);
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

  it("sends one morning message for all of Bro's own reports, not one each", async () => {
    // 09:00 in Moscow: the night is over and two reports are due at once.
    vi.useFakeTimers({
      now: new Date("2026-09-24T06:00:00.000Z"),
      toFake: ["Date"],
    });
    const report = scheduledReport();
    report.job.kind = "proactive";
    report.run.reportLeaseExpiresAt = new Date("2026-09-24T06:05:00.000Z");
    const held = {
      carriesEvent: false,
      carriesMove: false,
      conversationChannel: "photon" as const,
      jobId: report.job.id,
      jobKind: "proactive" as const,
      scheduledFor: new Date("2026-09-23T20:00:00.000Z"),
      scope: { userId: "user-1", workspaceId: "workspace-1" },
      timeSensitive: false,
    };
    services.listReports.mockResolvedValue([
      { ...held, runId: report.run.id },
      { ...held, runId: "00000000-0000-4000-8000-000000000077" },
    ]);
    services.claimReports.mockResolvedValue(report);
    services.absorb.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000077",
        outcome: {
          kind: "result",
          summary: "Фишинг: «служба безопасности банка» просит код.",
          urgency: "normal",
        },
        scheduledFor: held.scheduledFor,
      },
    ]);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession("main-session"));
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    try {
      await runSchedule(to);
    } finally {
      vi.useRealTimers();
    }

    expect(services.claimReports).toHaveBeenCalledOnce();
    expect(services.absorb).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: report.job.id, runId: report.run.id })
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toContain(
      "Earlier outcome, held for the person's morning"
    );
  });

  it("sends nothing of a letter's parcel watch found before the person turned Bro's own messages off", async () => {
    // 14:00 in Moscow: by day the news would go out at once.
    vi.useFakeTimers({
      now: new Date("2026-09-24T11:00:00.000Z"),
      toFake: ["Date"],
    });
    const report = scheduledReport();
    report.job.kind = "subscription";
    services.listReports.mockResolvedValue([
      {
        carriesEvent: false,
        carriesMove: false,
        conversationChannel: "photon",
        jobId: report.job.id,
        jobKind: "subscription",
        runId: report.run.id,
        scheduledFor: new Date("2026-09-23T20:30:00.000Z"),
        scope: { userId: "user-1", workspaceId: "workspace-1" },
        timeSensitive: false,
      },
    ]);
    services.claimReports.mockResolvedValue(report);
    profile.watch.mockResolvedValue({ unasked: true, wake: "day_only" });
    profile.enabled.mockResolvedValueOnce(false);
    const send = vi.fn<ReturnType<ScheduleToFn>["send"]>();
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    try {
      await runSchedule(to);
    } finally {
      vi.useRealTimers();
    }

    expect(send).not.toHaveBeenCalled();
    // Closed as Bro's own check closes its reports, not left to go later.
    expect(services.dropReport).toHaveBeenCalledExactlyOnceWith(
      report.run.id,
      report.run.reportLeaseToken,
      new Date("2026-09-24T11:00:00.000Z")
    );
  });

  it("delivers a web chat report through the schedule's own session handle", async () => {
    // The app's own routes never reach eve on Vercel, so a web chat report
    // must not go through one.
    const report = scheduledReport();
    report.delivery.conversationChannel = "eve";
    report.delivery.conversationId = "web-session";
    services.listReports.mockResolvedValue([
      {
        carriesEvent: false,
        carriesMove: false,
        conversationChannel: "eve",
        jobId: report.job.id,
        jobKind: "task",
        runId: report.run.id,
        scheduledFor: report.run.scheduledFor,
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
    files.share.mockReset();
    files.share.mockResolvedValue({
      bytes: 20_000,
      mediaType: "text/html",
      name: "Результат-2026-09-02.html",
      url: "https://example.com/synthetic-report.html?sig=test",
    });
    services.releaseReport.mockResolvedValue(true);
  });

  it("stores the whole long result in the worker's scope and delivers the exact attachment and reply handle", async () => {
    const report = scheduledReport();
    const summary = `${"Раздел 🧭 [Источник](https://example.com/source)\n".repeat(150)}ФИНАЛЬНЫЙ_SENTINEL_🏁`;
    report.delivery.replyAnchorMessageId = "original-message";
    report.run.workerSessionId = "worker-session";
    report.run.outcome = {
      details: "Последняя деталь 🔚.",
      kind: "result",
      summary,
      urgency: "time_sensitive",
    };
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession());

    await dispatchScheduledReport(
      { to: vi.fn<ScheduleToFn>(() => ({ send })) },
      report.run.id
    );

    expect(files.share).toHaveBeenCalledOnce();
    const uploaded = files.share.mock.calls[0]?.[0];
    expect(uploaded?.bytes).toBeInstanceOf(Uint8Array);
    expect(uploaded).toMatchObject({
      mediaType: "text/html",
      name: "Результат-2026-09-02.html",
      owner: {
        sessionId: "worker-session",
        workspaceId: report.job.workspaceId,
      },
    });
    const html = new TextDecoder().decode(files.share.mock.calls[0]?.[0].bytes);
    expect(html).toContain("ФИНАЛЬНЫЙ_SENTINEL_🏁");
    expect(html).toContain("Последняя деталь 🔚.");
    expect(html).not.toContain(report.job.prompt);
    expect(html).not.toContain(report.job.id);
    expect(html).not.toContain(report.run.id);
    expect(html).not.toContain("worker-session");
    expect(html).toContain("2026-09-02 09:00, Wednesday (America/New_York)");
    expect(report.run.outcome.summary).toBe(summary);
    const [prompt, options] = send.mock.calls[0] ?? [];
    expect(prompt).toContain(
      '"url":"https://example.com/synthetic-report.html?sig=test"'
    );
    expect(prompt).toContain(
      '"kind":"file","mimeType":"text/html","name":"Результат-2026-09-02.html"'
    );
    expect(prompt).toContain("send_message.attachments");
    expect(prompt).toContain('"urgency":"time_sensitive"');
    expect(prompt).not.toContain("ФИНАЛЬНЫЙ_SENTINEL_🏁");
    expect(prompt).toContain(
      `Reply handle: {"kind":"automation","id":"${report.job.id}"}`
    );
    expect(options?.auth?.attributes).toMatchObject({
      scheduledRunSessionId: "worker-session",
      photonReplyAnchorMessageId: "original-message",
    });
    expect(services.releaseReport).not.toHaveBeenCalled();
  });

  it.each([4000, 4001])(
    "creates a document only beyond the 4000-character boundary (%i)",
    async (size) => {
      const report = scheduledReport();
      report.run.workerSessionId = "worker-session";
      report.run.outcome = {
        kind: "result",
        summary: "Я".repeat(size),
        urgency: "normal",
      };
      services.claimReports.mockResolvedValue(report);
      const send = vi
        .fn<ReturnType<ScheduleToFn>["send"]>()
        .mockResolvedValue(workerSession());
      await dispatchScheduledReport(
        { to: vi.fn<ScheduleToFn>(() => ({ send })) },
        report.run.id
      );
      expect(files.share).toHaveBeenCalledTimes(size > 4000 ? 1 : 0);
      expect(send).toHaveBeenCalledOnce();
      const prompt = send.mock.calls[0]?.[0];
      expect(
        z.string().parse(prompt).includes(report.run.outcome.summary)
      ).toBe(size === 4000);
    }
  );

  it("includes long details in the file instead of dropping them from a short summary", async () => {
    const report = scheduledReport();
    report.run.workerSessionId = "worker-session";
    report.run.outcome = {
      kind: "result",
      summary: "Краткий итог.",
      details: `${"Деталь 🧭. ".repeat(600)}КОНЕЦ_ДЕТАЛЕЙ`,
      urgency: "normal",
    };
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession());
    await dispatchScheduledReport(
      { to: vi.fn<ScheduleToFn>(() => ({ send })) },
      report.run.id
    );
    expect(
      new TextDecoder().decode(files.share.mock.calls[0]?.[0].bytes)
    ).toContain("КОНЕЦ_ДЕТАЛЕЙ");
    expect(send.mock.calls[0]?.[0]).not.toContain("КОНЕЦ_ДЕТАЛЕЙ");
  });

  it.each(["proactive", "subscription"] as const)(
    "does not turn %s reports into documents",
    async (kind) => {
      const report = scheduledReport();
      report.job.kind = kind;
      report.run.workerSessionId = "worker-session";
      const summary = `${"Полный результат. ".repeat(500)}ФИНАЛ`;
      report.run.outcome = { kind: "result", summary, urgency: "normal" };
      services.claimReports.mockResolvedValue(report);
      const send = vi
        .fn<ReturnType<ScheduleToFn>["send"]>()
        .mockResolvedValue(workerSession());
      await dispatchScheduledReport(
        { to: vi.fn<ScheduleToFn>(() => ({ send })) },
        report.run.id
      );
      expect(files.share).not.toHaveBeenCalled();
      expect(send.mock.calls[0]?.[0]).toContain(summary);
    }
  );

  it("releases the report for retry on upload failure without delivering success or losing the outcome", async () => {
    const report = scheduledReport();
    report.run.workerSessionId = "worker-session";
    const summary = `${"Результат. ".repeat(500)}ФИНАЛ`;
    report.run.outcome = { kind: "result", summary, urgency: "normal" };
    services.claimReports.mockResolvedValue(report);
    files.share.mockRejectedValueOnce(new Error("Object Storage unavailable"));
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession());
    const delivery = { to: vi.fn<ScheduleToFn>(() => ({ send })) };
    await dispatchScheduledReport(delivery, report.run.id);
    expect(send).not.toHaveBeenCalled();
    expect(services.dropReport).not.toHaveBeenCalled();
    expect(services.releaseReport).toHaveBeenCalledExactlyOnceWith(
      report.run.id,
      report.run.reportLeaseToken,
      "Object Storage unavailable"
    );
    expect(report.run.outcome.summary).toBe(summary);
    await dispatchScheduledReport(delivery, report.run.id);
    expect(send).toHaveBeenCalledOnce();
    expect(files.share).toHaveBeenCalledTimes(2);
  });

  it("keeps the complete text fallback when no owning worker session is available", async () => {
    const report = scheduledReport();
    const summary = `${"Результат. ".repeat(500)}ФИНАЛ`;
    report.run.outcome = { kind: "result", summary, urgency: "normal" };
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession());
    await dispatchScheduledReport(
      { to: vi.fn<ScheduleToFn>(() => ({ send })) },
      report.run.id
    );
    expect(files.share).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toContain(summary);
    expect(send.mock.calls[0]?.[0]).not.toContain("Prepared document");
  });

  it("keeps a pending question ahead of a long stored result", async () => {
    const report = scheduledReport();
    report.run.workerSessionId = "worker-session";
    report.run.pendingInputRequests = answeredClaim().run.pendingInputRequests;
    report.run.outcome = {
      kind: "result",
      summary: "Результат. ".repeat(500),
      urgency: "normal",
    };
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession());
    await dispatchScheduledReport(
      { to: vi.fn<ScheduleToFn>(() => ({ send })) },
      report.run.id
    );
    expect(files.share).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toContain("Which airport should I use?");
    expect(send.mock.calls[0]?.[0]).not.toContain("Prepared document");
  });

  it("reuses one prepared file when an ended web chat falls back to a messenger", async () => {
    const report = scheduledReport();
    report.fallbacks = [
      { ...report.delivery, replyAnchorMessageId: "original-message" },
    ];
    report.delivery = {
      conversationChannel: "eve",
      conversationId: "ended-web",
      replyAnchorMessageId: null,
    };
    report.run.workerSessionId = "worker-session";
    report.run.outcome = {
      kind: "result",
      summary: "Результат. ".repeat(500),
      urgency: "normal",
    };
    services.claimReports.mockResolvedValue(report);
    const webSend = vi
      .fn<Session["send"]>()
      .mockResolvedValue({ status: "session_not_active", retryable: false });
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession());
    await dispatchScheduledReport(
      {
        attachSession: () => workerSession("ended-web", webSend),
        to: vi.fn<ScheduleToFn>(() => ({ send })),
      },
      report.run.id
    );
    expect(files.share).toHaveBeenCalledOnce();
    expect(webSend.mock.calls[0]?.[0]).toContain(
      "https://example.com/synthetic-report.html?sig=test"
    );
    expect(send.mock.calls[0]?.[0]).toContain(
      "https://example.com/synthetic-report.html?sig=test"
    );
    expect(send.mock.calls[0]?.[0]).toContain(
      `Reply handle: {"kind":"automation","id":"${report.job.id}"}`
    );
    expect(services.dropReport).not.toHaveBeenCalled();
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
    expect(prompt).toContain("check of the person's mail and calendar");
  });

  it("frames the report of a live location's move as a look at where the person is", async () => {
    const report = scheduledReport();
    report.job.kind = "proactive";
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession("main-session"));

    await dispatchScheduledReport(
      { to: vi.fn<ScheduleToFn>(() => ({ send })) },
      report.run.id,
      { moved: true }
    );

    const prompt = send.mock.calls[0]?.[0];
    expect(prompt).toContain("by the live location they share in Telegram");
    expect(prompt).not.toContain("check of the person's mail and calendar");
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
      delegation: null,
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

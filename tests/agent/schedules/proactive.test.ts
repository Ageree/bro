import type { Session } from "eve/channels";
import type { ScheduleHandlerArgs, ScheduleToFn } from "eve/schedules";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { probeGoogleSignals } from "@agent/lib/proactive/probe";
import type {
  advanceProactiveWatermark,
  claimDueProactiveWatches,
  deferProactiveWatch,
  filterUnseenProactiveSignals,
  listProactiveRunSignals,
  pruneProactiveSignals,
  queueProactiveRun,
} from "@db/services/proactive";
import type {
  claimReadyScheduledAgentRuns,
  releaseScheduledAgentRun,
  setScheduledRunSession,
} from "@db/services/scheduled-agent-jobs";

const proactive = vi.hoisted(() => ({
  advance: vi.fn<typeof advanceProactiveWatermark>(),
  claimWatches: vi.fn<typeof claimDueProactiveWatches>(),
  defer: vi.fn<typeof deferProactiveWatch>(),
  filterUnseen: vi.fn<typeof filterUnseenProactiveSignals>(),
  listSignals: vi.fn<typeof listProactiveRunSignals>(),
  prune: vi.fn<typeof pruneProactiveSignals>(),
  queue: vi.fn<typeof queueProactiveRun>(),
}));
const jobs = vi.hoisted(() => ({
  claimRuns: vi.fn<typeof claimReadyScheduledAgentRuns>(),
  releaseRun: vi.fn<typeof releaseScheduledAgentRun>(),
  setSession: vi.fn<typeof setScheduledRunSession>(),
}));
const probe = vi.hoisted(() => vi.fn<typeof probeGoogleSignals>());

vi.mock("@db/services/proactive", () => ({
  advanceProactiveWatermark: proactive.advance,
  claimDueProactiveWatches: proactive.claimWatches,
  deferProactiveWatch: proactive.defer,
  filterUnseenProactiveSignals: proactive.filterUnseen,
  listProactiveRunSignals: proactive.listSignals,
  pruneProactiveSignals: proactive.prune,
  queueProactiveRun: proactive.queue,
}));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  claimReadyScheduledAgentRuns: jobs.claimRuns,
  releaseScheduledAgentRun: jobs.releaseRun,
  setScheduledRunSession: jobs.setSession,
}));
vi.mock("@agent/lib/proactive/probe", () => ({ probeGoogleSignals: probe }));
vi.mock("@agent/channels/scheduled-run", () => ({
  default: { channel: "scheduled-run" },
}));

import proactiveSchedule from "@agent/schedules/proactive";

// 15:00 in Moscow: outside quiet hours.
const afternoon = new Date("2026-09-23T12:00:00.000Z");
const flight = {
  dedupeKey: "flight@2026-09-24T07:40:00+03:00",
  itemId: "flight",
  source: "calendar" as const,
  threadId: null,
};

describe("proactive schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: afternoon, toFake: ["Date"] });
    proactive.claimWatches.mockResolvedValue([watch()]);
    proactive.filterUnseen.mockImplementation((_workspaceId, candidates) =>
      Promise.resolve([...candidates])
    );
    proactive.queue.mockResolvedValue({
      runId: "00000000-0000-4000-8000-000000000002",
      status: "queued",
    });
    jobs.claimRuns.mockResolvedValue([]);
    jobs.setSession.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues one run with the new signals and moves the watermark", async () => {
    probe.mockResolvedValue({ signals: [flight], state: "connected" });

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(probe).toHaveBeenCalledExactlyOnceWith(
      { userId: "better-auth:alice", workspaceId: "workspace:alice" },
      {
        mailAfter: new Date("2026-09-23T11:35:00.000Z"),
        now: afternoon,
        timeZone: "Europe/Moscow",
      }
    );
    expect(proactive.queue).toHaveBeenCalledExactlyOnceWith({
      jobId: "00000000-0000-4000-8000-000000000001",
      mailCheckedAt: afternoon,
      maxRunsPerDay: 12,
      now: afternoon,
      signals: [flight],
      workspaceId: "workspace:alice",
    });
    expect(proactive.advance).not.toHaveBeenCalled();
    expect(jobs.claimRuns).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "proactive" })
    );
  });

  it("turns a backlog into one catch-up run with the newest mail", async () => {
    const mail = Array.from({ length: 15 }, (_, index) => ({
      dedupeKey: `m${String(index)}`,
      itemId: `m${String(index)}`,
      source: "gmail" as const,
      threadId: `t${String(index)}`,
    }));
    probe.mockResolvedValue({ signals: mail, state: "connected" });

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(proactive.queue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        mailCheckedAt: afternoon,
        signals: mail.slice(0, 12),
      })
    );
  });

  it("starts no model run when every signal was already handled", async () => {
    probe.mockResolvedValue({ signals: [flight], state: "connected" });
    proactive.filterUnseen.mockResolvedValue([]);

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(proactive.queue).not.toHaveBeenCalled();
    expect(proactive.advance).toHaveBeenCalledExactlyOnceWith(
      "workspace:alice",
      afternoon
    );
  });

  it("does not even look at Google during quiet hours", async () => {
    // 23:30 in Moscow.
    vi.setSystemTime(new Date("2026-09-23T20:30:00.000Z"));

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(probe).not.toHaveBeenCalled();
    expect(proactive.defer).toHaveBeenCalledExactlyOnceWith(
      watch(),
      new Date("2026-09-24T05:00:00.000Z")
    );
  });

  it("backs off for hours when Google is not connected", async () => {
    probe.mockResolvedValue({ state: "disconnected" });

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(proactive.defer).toHaveBeenCalledExactlyOnceWith(
      watch(),
      new Date("2026-09-23T18:00:00.000Z"),
      "disconnected"
    );
    expect(proactive.queue).not.toHaveBeenCalled();
  });

  it("keeps checking other workspaces when one probe fails", async () => {
    proactive.claimWatches.mockResolvedValue([
      watch(),
      { ...watch(), workspaceId: "workspace:bob" },
    ]);
    probe
      .mockRejectedValueOnce(new Error("Gmail is down"))
      .mockResolvedValueOnce({ signals: [flight], state: "connected" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await runSchedule(vi.fn<ScheduleToFn>());

    expect(proactive.queue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspaceId: "workspace:bob" })
    );
  });

  it("dispatches a claimed run as a proactive worker with its signals", async () => {
    probe.mockResolvedValue({ signals: [], state: "connected" });
    proactive.listSignals.mockResolvedValue([
      { itemId: "flight", source: "calendar", threadId: null },
    ]);
    const claim = proactiveClaim();
    jobs.claimRuns.mockResolvedValue([claim]);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(workerSession());
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await runSchedule(to);

    expect(to).toHaveBeenCalledWith(expect.anything(), {
      restart: false,
      runId: claim.run.id,
    });
    expect(send.mock.calls[0]?.[0]).toContain("these ids): flight");
    expect(send.mock.calls[0]?.[1].auth).toMatchObject({
      attributes: {
        conversationChannel: "telegram",
        scheduledRunKind: "proactive",
        scheduledRunLeaseToken: claim.run.leaseToken,
        scheduledRunId: claim.run.id,
        workspaceId: "workspace:alice",
      },
      authenticator: "scheduled-worker",
      principalId: "better-auth:alice",
    });
    expect(jobs.setSession).toHaveBeenCalledExactlyOnceWith(
      claim.run.id,
      claim.run.leaseToken,
      "worker-session"
    );
  });
});

async function runSchedule(to: ScheduleToFn) {
  let task: Promise<unknown> | undefined;
  const args: ScheduleHandlerArgs = {
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    attachSession: vi.fn<ScheduleHandlerArgs["attachSession"]>(),
    to,
    waitUntil(backgroundTask) {
      task = backgroundTask;
    },
  };
  proactiveSchedule.run(args);
  await task;
}

function watch(): Awaited<ReturnType<typeof claimDueProactiveWatches>>[number] {
  return {
    createdByUserId: "better-auth:alice",
    googleState: "connected",
    jobId: "00000000-0000-4000-8000-000000000001",
    leaseUntil: new Date("2026-09-23T12:15:00.000Z"),
    mailCheckedAt: new Date("2026-09-23T11:45:00.000Z"),
    timezone: "Europe/Moscow",
    workspaceId: "workspace:alice",
  };
}

function proactiveClaim(): Awaited<
  ReturnType<typeof claimReadyScheduledAgentRuns>
>[number] {
  return {
    job: {
      conversationChannel: "telegram",
      conversationId: "100::",
      createdAt: afternoon,
      createdByUserId: "better-auth:alice",
      id: "00000000-0000-4000-8000-000000000001",
      kind: "proactive",
      lastError: null,
      lastRunAt: afternoon,
      missedRunPolicy: "skip",
      nextRunAt: null,
      prompt: "Проверить почту и календарь.",
      replyAnchorMessageId: null,
      revision: 0,
      status: "active",
      timing: {
        anchoredAt: afternoon.toISOString(),
        everyMinutes: 15,
        kind: "interval",
      },
      updatedAt: afternoon,
      workspaceId: "workspace:alice",
    },
    run: {
      attempts: 1,
      completedAt: null,
      createdAt: afternoon,
      deferredCompletionTurnId: null,
      id: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000001",
      lastError: null,
      leaseExpiresAt: new Date("2026-09-23T12:05:00.000Z"),
      leaseToken: "00000000-0000-4000-8000-000000000003",
      outcome: null,
      inputResponses: null,
      pendingInputRequests: null,
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      reportSequence: 0,
      reportStatus: "not_ready",
      retryAt: null,
      scheduledFor: afternoon,
      startedAt: null,
      status: "running",
      updatedAt: afternoon,
      workerSessionId: null,
    },
  };
}

function workerSession(): Session {
  return {
    cancel: vi.fn<Session["cancel"]>(),
    clear: vi.fn<Session["clear"]>(),
    compact: vi.fn<Session["compact"]>(),
    getEventStream: vi.fn<Session["getEventStream"]>(),
    getStreamTailIndex: vi.fn<Session["getStreamTailIndex"]>(),
    id: "worker-session",
    reset: vi.fn<Session["reset"]>(),
    respond: vi.fn<Session["respond"]>(),
    send: vi.fn<Session["send"]>(),
  };
}

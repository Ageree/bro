import type { Session } from "eve/channels";
import type { ScheduleHandlerArgs, ScheduleToFn } from "eve/schedules";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runId = "11111111-1111-4111-8111-111111111111";
const eveSessionId = "eve-session-1";

// One browser run row, held the way the database would hold it, so the
// schedule and the completion path it drives run for real against it.
interface BrowserRunState {
  completedAt: Date | null;
  conversationChannel: "eve";
  conversationId: string;
  createdAt: Date;
  createdByUserId: string;
  id: string;
  liveViewUrl: string | null;
  outcome: string | null;
  report: string | null;
  reportAttempts: number;
  reportClaimedAt: Date | null;
  reportDeliveredAt: Date | null;
  rootSessionId: string | null;
  site: string | null;
  status: string;
  task: string;
  updatedAt: Date;
  workspaceId: string;
}

function freshRow(): BrowserRunState {
  return {
    completedAt: null,
    conversationChannel: "eve",
    conversationId: eveSessionId,
    createdAt: new Date(Date.now() - 5 * 60_000),
    createdByUserId: "better-auth:user-1",
    id: runId,
    liveViewUrl: null,
    outcome: null,
    report: null,
    reportAttempts: 0,
    reportClaimedAt: null,
    reportDeliveredAt: null,
    rootSessionId: eveSessionId,
    site: null,
    status: "running",
    task: "Find a hotel",
    updatedAt: new Date(Date.now() - 5 * 60_000),
    workspaceId: "workspace:user-1",
  };
}

interface RunTable {
  row?: BrowserRunState;
}

const state = vi.hoisted((): RunTable => ({}));

function currentRow() {
  if (!state.row) throw new Error("The test run row is missing.");
  return state.row;
}

vi.mock("@db/services/browser-runs", () => ({
  claimBrowserRunCompletion: (
    _id: string,
    input: { outcome: string; report?: string; status: string }
  ) => {
    if (currentRow().completedAt) return Promise.resolve(undefined);
    const completedAt = new Date();
    Object.assign(currentRow(), input, { completedAt });
    // The settler holds the plain report's lease while it finishes it.
    if (input.report !== undefined) currentRow().reportClaimedAt = completedAt;
    return Promise.resolve({ ...currentRow() });
  },
  claimBrowserRunReport: () => {
    const { report, reportClaimedAt, reportDeliveredAt } = currentRow();
    if (!report || reportClaimedAt || reportDeliveredAt) {
      return Promise.resolve(undefined);
    }
    currentRow().reportClaimedAt = new Date();
    currentRow().reportAttempts += 1;
    return Promise.resolve({ ...currentRow() });
  },
  claimDueBrowserRunRetries: () => Promise.resolve([]),
  hasLiveBrowserRuns: () => Promise.resolve(false),
  parkBrowserRunForRetry: () => Promise.resolve(true),
  finishBrowserRunReport: () => {
    currentRow().reportClaimedAt = null;
    currentRow().reportDeliveredAt = new Date();
    return Promise.resolve();
  },
  listPendingBrowserRunReports: () =>
    Promise.resolve(
      currentRow().report &&
        !currentRow().reportClaimedAt &&
        !currentRow().reportDeliveredAt
        ? [{ id: currentRow().id }]
        : []
    ),
  claimNextQueuedBrowserRun: () => Promise.resolve(undefined),
  listOverdueBrowserRunReports: () => Promise.resolve([]),
  // One take per poll: the row is checked once, like the real round-robin.
  takeUnsettledBrowserRuns: ({ checkedBefore }: { checkedBefore: Date }) => {
    const row = currentRow();
    if (row.completedAt || row.updatedAt >= checkedBefore) {
      return Promise.resolve([]);
    }
    row.updatedAt = new Date(checkedBefore.getTime() + 1);
    return Promise.resolve([{ ...row }]);
  },
  readBrowserRun: () => Promise.resolve({ ...currentRow() }),
  releaseBrowserRunReport: () => {
    currentRow().reportClaimedAt = null;
    return Promise.resolve();
  },
  saveBrowserRunReport: (_id: string, report: string) => {
    currentRow().report = report;
    currentRow().reportClaimedAt = null;
    return Promise.resolve();
  },
}));
vi.mock("@db/services/orders", () => ({
  recordOrder: vi.fn<() => Promise<void>>(),
}));
vi.mock("@db/services/spending", () => ({
  listStaleSpendReservations: () => Promise.resolve([]),
  readSpendEntryForRun: () => Promise.resolve(undefined),
  releaseAbandonedSpendReservations: () => Promise.resolve(),
  settleSpendReservation: () => Promise.resolve(undefined),
}));
vi.mock("@agent/lib/browser-use/client", () => ({
  browserUseConfigured: () => true,
  cancelBrowserUseRun: vi.fn<() => Promise<void>>(),
  readBrowserUseRun: () =>
    Promise.resolve({
      error: null,
      id: runId,
      result: "RESULT: found three hotels\nNEEDS: none",
      sessionId: "browser-session-1",
      status: "completed",
      task: "Find a hotel",
    }),
  readBrowserUseRunStatus: () => Promise.resolve("completed"),
  stopBrowserUseSessionBrowsers: () => Promise.resolve(1),
}));
vi.mock("@agent/lib/browser-use/images", () => ({
  captureBrowserRunImages: () => Promise.resolve([]),
}));
vi.mock("@agent/lib/owner-alert", () => ({
  alertOwner: () => Promise.resolve(false),
  clearOwnerAlert: () => Promise.resolve(),
}));
vi.mock("@agent/channels/photon", () => ({ default: { id: "photon" } }));
vi.mock("@agent/channels/telegram", () => ({ default: { id: "telegram" } }));

import browserRunsSchedule from "@agent/schedules/browser-runs";

beforeEach(() => {
  state.row = freshRow();
});

function eveSession(...results: Awaited<ReturnType<Session["send"]>>[]) {
  const send = vi.fn<Session["send"]>();
  for (const result of results) send.mockResolvedValueOnce(result);
  const attachSession = vi.fn<ScheduleHandlerArgs["attachSession"]>((id) => ({
    cancel: vi.fn<Session["cancel"]>(),
    clear: vi.fn<Session["clear"]>(),
    compact: vi.fn<Session["compact"]>(),
    getEventStream: vi.fn<Session["getEventStream"]>(),
    getStreamTailIndex: vi.fn<Session["getStreamTailIndex"]>(),
    id,
    reset: vi.fn<Session["reset"]>(),
    respond: vi.fn<Session["respond"]>(),
    send,
  }));
  return { attachSession, send };
}

async function tick(attachSession: ScheduleHandlerArgs["attachSession"]) {
  const to = vi.fn<ScheduleToFn>(() => {
    throw new Error("An eve chat is not reached through a channel target.");
  });
  const tasks: Promise<unknown>[] = [];
  browserRunsSchedule.run({
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    attachSession,
    to,
    waitUntil: (task) => tasks.push(task),
  });
  await Promise.all(tasks);
  return to;
}

describe("reconciling a browser run started from the web chat", () => {
  it("settles the run and reports it into the same eve session without a webhook", async () => {
    const { attachSession, send } = eveSession({
      sessionId: eveSessionId,
      status: "accepted",
    });

    const to = await tick(attachSession);

    expect(attachSession).toHaveBeenCalledExactlyOnceWith(eveSessionId);
    expect(send).toHaveBeenCalledOnce();
    const [message, options] = send.mock.calls[0] ?? [];
    expect(message).toContain(`Browser run ${runId} finished`);
    expect(message).toContain("found three hotels");
    expect(options).toMatchObject({
      auth: {
        attributes: {
          browserRunId: runId,
          conversationChannel: "eve",
          conversationId: eveSessionId,
        },
        principalId: "better-auth:user-1",
      },
      turnPolicy: "queue",
    });
    expect(to).not.toHaveBeenCalled();
    expect(currentRow().status).toBe("done");
    // Handed over, not yet heard: the report turn confirms it.
    expect(currentRow().reportClaimedAt).toBeInstanceOf(Date);
    expect(currentRow().reportDeliveredAt).toBeNull();
  });

  it("keeps an undelivered outcome and delivers it on a later poll", async () => {
    const { attachSession, send } = eveSession(
      { retryable: true, status: "session_not_active" },
      { retryable: true, status: "session_not_active" },
      { sessionId: eveSessionId, status: "accepted" }
    );

    await tick(attachSession);

    expect(currentRow().completedAt).toBeInstanceOf(Date);
    expect(currentRow().reportDeliveredAt).toBeNull();
    expect(currentRow().report).toContain(`Browser run ${runId} finished`);

    await tick(attachSession);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0]).toBe(currentRow().report);
    expect(currentRow().reportClaimedAt).toBeInstanceOf(Date);
    expect(currentRow().reportAttempts).toBe(3);
  });
});

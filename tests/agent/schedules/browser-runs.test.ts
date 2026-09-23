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
    input: { outcome: string; status: string }
  ) => {
    if (currentRow().completedAt) return Promise.resolve(undefined);
    Object.assign(currentRow(), input, { completedAt: new Date() });
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
  listUnsettledBrowserRuns: () =>
    Promise.resolve(currentRow().completedAt ? [] : [{ ...currentRow() }]),
  readBrowserRun: () => Promise.resolve({ ...currentRow() }),
  releaseBrowserRunReport: () => {
    currentRow().reportClaimedAt = null;
    return Promise.resolve();
  },
  saveBrowserRunReport: (_id: string, report: string) => {
    currentRow().report = report;
    return Promise.resolve();
  },
}));
vi.mock("@db/services/orders", () => ({
  recordOrder: vi.fn<() => Promise<void>>(),
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
}));
vi.mock("@agent/lib/browser-use/images", () => ({
  captureBrowserRunImages: () => Promise.resolve([]),
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
    expect(currentRow().reportDeliveredAt).toBeInstanceOf(Date);
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
    expect(currentRow().reportDeliveredAt).toBeInstanceOf(Date);
    expect(currentRow().reportAttempts).toBe(3);
  });
});

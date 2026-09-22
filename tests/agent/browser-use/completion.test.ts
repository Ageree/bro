import type { ScheduleToFn } from "eve/schedules";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runId = "11111111-1111-4111-8111-111111111111";

interface BrowserRunRow {
  completedAt: Date | null;
  conversationChannel: "photon";
  conversationId: string;
  createdByUserId: string;
  id: string;
  liveViewUrl: string;
  task: string;
  workspaceId: string;
}

const row: BrowserRunRow = {
  completedAt: null,
  conversationChannel: "photon" as const,
  conversationId: "imessage:chat-1",
  createdByUserId: "better-auth:user-1",
  id: runId,
  liveViewUrl: "https://live.browser-use.test/abc",
  task: "Order the usual",
  workspaceId: "workspace:user-1",
};

interface RunSummary {
  error: string | null;
  id: string;
  result: string | null;
  sessionId: string;
  status: string;
  task: string;
}

const readBrowserRun = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<BrowserRunRow>>()
);
const claimBrowserRunCompletion = vi.hoisted(() =>
  vi.fn<
    (
      runId: string,
      input: { outcome: string; status: string }
    ) => Promise<BrowserRunRow | undefined>
  >()
);
const readBrowserUseRun = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<RunSummary>>()
);
const cancelBrowserUseRun = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<void>>()
);

vi.mock("@db/services/browser-runs", () => ({
  claimBrowserRunCompletion,
  readBrowserRun,
}));
vi.mock("@agent/lib/browser-use/client", () => ({
  cancelBrowserUseRun,
  readBrowserUseRun,
}));
vi.mock("@agent/channels/photon", () => ({ default: { id: "photon" } }));

beforeEach(() => {
  vi.clearAllMocks();
  readBrowserRun.mockResolvedValue(row);
  readBrowserUseRun.mockResolvedValue({
    error: null,
    id: runId,
    result: "RESULT: ordered\nORDER: 4417\nNEEDS: none",
    sessionId: "session-1",
    status: "completed",
    task: "Order the usual",
  });
  claimBrowserRunCompletion
    .mockResolvedValueOnce({ ...row, completedAt: new Date() })
    .mockResolvedValue(undefined);
});

type ChannelSend = ReturnType<ScheduleToFn>["send"];

function delivery() {
  const send = vi.fn<ChannelSend>();
  const to: ScheduleToFn = () => ({ send });
  return { send, to };
}

describe("settling a browser run", () => {
  it("reports a finished run into its originating conversation exactly once", async () => {
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);
    await settleBrowserRun({ to }, runId);

    expect(claimBrowserRunCompletion).toHaveBeenCalledTimes(2);
    expect(claimBrowserRunCompletion).toHaveBeenNthCalledWith(1, runId, {
      outcome: "Result: ordered\nOrder: 4417",
      status: "done",
    });
    expect(send).toHaveBeenCalledOnce();
    const prompt = send.mock.calls[0]?.[0];
    expect(prompt).toContain(`Browser run ${runId} finished`);
    expect(prompt).toContain("Result: ordered");
  });

  it("persists validated links and requires named links in the final response", async () => {
    readBrowserUseRun.mockResolvedValue({
      error: null,
      id: runId,
      result: [
        "RESULT: found a useful article",
        "ORDER: none",
        "NEEDS: none",
        'LINKS: [{"title":"Useful article","url":"https://example.com/article?source=search#part-2"}]',
      ].join("\n"),
      sessionId: "session-1",
      status: "completed",
      task: "Find an article",
    });
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);

    expect(claimBrowserRunCompletion).toHaveBeenCalledWith(runId, {
      outcome:
        'Result: found a useful article\nLinks: [{"title":"Useful article","url":"https://example.com/article?source=search#part-2"}]',
      status: "done",
    });
    const prompt = send.mock.calls[0]?.[0];
    expect(prompt).toContain("Useful article");
    expect(prompt).toContain(
      "https://example.com/article?source=search#part-2"
    );
    expect(prompt).toContain("Include every relevant returned link");
    expect(prompt).toContain("labelled Markdown links in web and Telegram");
    expect(prompt).toContain("iMessage compiler");
  });

  it("does not let a names-only option search masquerade as complete", async () => {
    readBrowserUseRun.mockResolvedValue({
      error: null,
      id: runId,
      result: "RESULT: found Hotel One and Hotel Two\nNEEDS: none\nLINKS: []",
      sessionId: "session-1",
      status: "completed",
      task: "Find hotels",
    });
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);

    const prompt = send.mock.calls[0]?.[0];
    expect(prompt).toContain("do not present a names-only list");
    expect(prompt).toContain("Continue this run once");
    expect(prompt).toContain("Do not retry in a loop");
  });

  it("leaves a run that has not reached a terminal status alone", async () => {
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    readBrowserUseRun.mockResolvedValue({
      error: null,
      id: runId,
      result: null,
      sessionId: "session-1",
      status: "running",
      task: "Order the usual",
    });
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);

    expect(claimBrowserRunCompletion).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("never settles a run that was already reported", async () => {
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    readBrowserRun.mockResolvedValue({ ...row, completedAt: new Date() });
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);

    expect(readBrowserUseRun).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels and fails a run that ran out of time", async () => {
    const { expireBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    const { send, to } = delivery();

    await expireBrowserRun({ to }, runId);

    expect(cancelBrowserUseRun).toHaveBeenCalledExactlyOnceWith(runId);
    expect(claimBrowserRunCompletion).toHaveBeenCalledExactlyOnceWith(runId, {
      outcome: "The browser run ran out of time and was cancelled.",
      status: "failed",
    });
    expect(send).toHaveBeenCalledOnce();
  });
});

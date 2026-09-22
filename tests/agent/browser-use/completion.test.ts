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
      outcome: "Task status: complete\nResult: ordered\nOrder: 4417",
      status: "done",
    });
    expect(send).toHaveBeenCalledOnce();
    const prompt = send.mock.calls[0]?.[0];
    expect(prompt).toContain(
      `Browser run ${runId} reached a provider-terminal state`
    );
    expect(prompt).toContain("Result: ordered");
    expect(prompt).toContain("BEGIN UNTRUSTED BROWSER DATA");
  });

  it("delivers a substantive report written before the protocol block", async () => {
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    readBrowserUseRun.mockResolvedValue({
      error: null,
      id: runId,
      result: [
        "| # | Title | Updated | URL |",
        "|---|---|---|---|",
        "| 1 | Meta: Language Model Unavailable | Sep 20, 2026 | https://github.com/microsoft/vscode/issues/253137 |",
        "| 2 | Meta: Sorry, no response was returned | Sep 19, 2026 | https://github.com/microsoft/vscode/issues/253126 |",
        "| 3 | Dataverse MCP Server schema invalid | Sep 17, 2026 | https://github.com/microsoft/vscode/issues/326912 |",
        "",
        "RESULT: Found and verified exactly three open bug issues mentioning notebook.",
        "ORDER: none",
        "TOTAL: none",
        "NEEDS: none",
        "DETAILS: none",
        "STATUS: complete",
        "EVIDENCE: https://github.com/microsoft/vscode/issues?q=is%3Aissue%20is%3Aopen%20label%3Abug",
        "NEXT: none",
      ].join("\n"),
      sessionId: "session-1",
      status: "completed",
      task: "Find current notebook issues",
    });
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);

    const stored = claimBrowserRunCompletion.mock.calls[0]?.[1]?.outcome;
    expect(stored).toContain("Report: | # | Title | Updated | URL |");
    expect(stored).toContain("Meta: Language Model Unavailable");
    expect(stored).toContain(
      "Result: Found and verified exactly three open bug issues mentioning notebook."
    );
    expect(send.mock.calls[0]?.[0]).toContain(
      "Meta: Language Model Unavailable"
    );
  });

  it("does not mark provider completion as task success when work remains", async () => {
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    readBrowserUseRun.mockResolvedValue({
      error: null,
      id: runId,
      result:
        "STATUS: complete\nRESULT: reached payment\nNEEDS: 3ds\nDETAILS: approve in bank app",
      sessionId: "session-1",
      status: "completed",
      task: "Order the usual",
    });
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);

    expect(claimBrowserRunCompletion).toHaveBeenCalledOnce();
    expect(claimBrowserRunCompletion.mock.calls[0]?.[0]).toBe(runId);
    expect(claimBrowserRunCompletion.mock.calls[0]?.[1]?.status).toBe("failed");
    expect(claimBrowserRunCompletion.mock.calls[0]?.[1]?.outcome).toContain(
      "Task status: blocked"
    );
    expect(send.mock.calls[0]?.[0]).toContain(
      "The errand is blocked, not complete"
    );
  });

  it("does not report an explicit partial result as done", async () => {
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    readBrowserUseRun.mockResolvedValue({
      error: null,
      id: runId,
      result:
        "STATUS: partial\nRESULT: found two options\nEVIDENCE: https://example.com/a\nNEEDS: none\nNEXT: verify a third option",
      sessionId: "session-1",
      status: "completed",
      task: "Compare options",
    });
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);

    expect(claimBrowserRunCompletion).toHaveBeenCalledOnce();
    expect(claimBrowserRunCompletion.mock.calls[0]?.[0]).toBe(runId);
    expect(claimBrowserRunCompletion.mock.calls[0]?.[1]?.status).toBe("failed");
    expect(claimBrowserRunCompletion.mock.calls[0]?.[1]?.outcome).toContain(
      "Task status: partial"
    );
    expect(send.mock.calls[0]?.[0]).toContain("Report the useful progress");
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

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
const captureBrowserRunImages = vi.hoisted(() =>
  vi.fn<
    (
      row: BrowserRunRow,
      run: RunSummary
    ) => Promise<{ id: string; label: string }[]>
  >()
);

vi.mock("@db/services/browser-runs", () => ({
  claimBrowserRunCompletion,
  readBrowserRun,
}));
vi.mock("@agent/lib/browser-use/client", () => ({
  cancelBrowserUseRun,
  readBrowserUseRun,
}));
vi.mock("@agent/lib/browser-use/images", () => ({
  captureBrowserRunImages,
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
  captureBrowserRunImages.mockResolvedValue([]);
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

  it("hands the coordinator the pictures the run saved, ready to attach", async () => {
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    const screenshotId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
    const photoId = "206c3a7e-c0b8-4317-9e34-552cff646673";
    captureBrowserRunImages.mockResolvedValue([
      { id: screenshotId, label: "скриншот страницы с результатом" },
      { id: photoId, label: "xiaomi band 9" },
    ]);
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);

    expect(captureBrowserRunImages).toHaveBeenCalledOnce();
    const prompt = send.mock.calls[0]?.[0];
    expect(prompt).toContain("![caption](/artifacts/<id>)");
    expect(prompt).toContain(
      `- ${screenshotId}: скриншот страницы с результатом`
    );
    expect(prompt).toContain(`- ${photoId}: xiaomi band 9`);
    expect(prompt).toContain("never paste the /artifacts/ path as a bare link");
  });

  it("says nothing about pictures when the run saved none", async () => {
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);

    expect(send.mock.calls[0]?.[0]).not.toContain("/artifacts/");
  });

  it("still reports the errand when its pictures could not be kept", async () => {
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    captureBrowserRunImages.mockRejectedValue(new Error("Blob is down"));
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toContain("Result: ordered");
  });

  it("keeps no pictures from a run parked on an anti-bot check", async () => {
    const { settleBrowserRun } =
      await import("@agent/lib/browser-use/completion");
    readBrowserUseRun.mockResolvedValue({
      error: null,
      id: runId,
      result: "RESULT: стоит на проверке\nNEEDS: captcha",
      sessionId: "session-1",
      status: "completed",
      task: "Order the usual",
    });
    const { send, to } = delivery();

    await settleBrowserRun({ to }, runId);

    expect(captureBrowserRunImages).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
});

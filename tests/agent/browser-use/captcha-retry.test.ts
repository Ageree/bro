import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserUseCreateRunInput } from "@agent/lib/browser-use/client";
import type { AccessScope } from "@shared/identity/access-scope";

const runId = "11111111-1111-4111-8111-111111111111";
const retryRunId = "55555555-5555-4555-8555-555555555555";

const createBrowserUseRun = vi.hoisted(() =>
  vi.fn<
    (input: BrowserUseCreateRunInput) => Promise<{
      id: string;
      model: string;
      sessionId: string;
      status: string;
    }>
  >()
);
const readBrowserUseRun = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<{ task: string }>>()
);
const findRecentBrowserUseRunByTaskLine = vi.hoisted(() =>
  vi.fn<
    (line: string) => Promise<{ id: string; sessionId: string } | undefined>
  >(() => Promise.resolve(undefined))
);
const cancelBrowserUseRun = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<void>>(() => Promise.resolve())
);
const handOffBrowserRunRetry = vi.hoisted(() =>
  vi.fn<
    (
      fromRunId: string,
      retry: { readonly captchaAttempt: number; readonly id: string }
    ) => Promise<boolean>
  >(() => Promise.resolve(true))
);
const readBrowserRun = vi.hoisted(() =>
  vi.fn<
    (
      runId: string
    ) => Promise<{ retriedAsRunId: string | null; status: string } | undefined>
  >(() => Promise.resolve({ retriedAsRunId: null, status: "waiting" }))
);
const parkBrowserRunForRetry = vi.hoisted(() =>
  vi.fn<
    (
      runId: string,
      input: { captchaAttempt: number; retryAt: Date }
    ) => Promise<boolean>
  >(() => Promise.resolve(true))
);
const resolveBrowserSecretBindings = vi.hoisted(() =>
  vi.fn<
    (
      scope: AccessScope,
      options: { allowPayment: boolean; site: string | undefined }
    ) => Promise<{ aliases: string[]; bindings: [] }>
  >(() => Promise.resolve({ aliases: [], bindings: [] }))
);

vi.mock("@agent/lib/browser-use/client", () => ({
  cancelBrowserUseRun,
  createBrowserUseRun,
  findRecentBrowserUseRunByTaskLine,
  readBrowserUseRun,
}));
vi.mock("@db/services/browser-runs", () => ({
  handOffBrowserRunRetry,
  parkBrowserRunForRetry,
  readBrowserRun,
}));
vi.mock("@agent/lib/browser-use/secrets", () => ({
  resolveBrowserSecretBindings,
}));

function parkedRow(captchaAttempt: number) {
  return {
    captchaAttempt,
    completedAt: new Date(),
    conversationChannel: "photon" as const,
    conversationId: "imessage:chat-1",
    createdAt: new Date(),
    createdByUserId: "better-auth:alice",
    id: runId,
    liveViewUrl: null,
    outcome: "Needs: captcha",
    paymentAllowed: true,
    profileId: "profile-1",
    replyAnchorMessageId: "message-1",
    report: null,
    reportAttempts: 0,
    reportClaimedAt: null,
    reportDeliveredAt: null,
    retriedAsRunId: null,
    retryAt: null,
    rootSessionId: "session-root",
    sessionId: "walled-session",
    site: "https://shop.example",
    status: "waiting" as const,
    task: "Купи корм",
    updatedAt: new Date(),
    workspaceId: "workspace:alice",
  };
}

beforeEach(() => {
  vi.resetModules();
  // Every case starts from the hosted pool, whatever the shell exports.
  vi.stubEnv("BROWSER_USE_PROXY_HOST", "");
  vi.stubEnv("BROWSER_USE_PROXY_PORT", "");
  vi.stubEnv("BROWSER_USE_PROXY_USERNAME", "");
  vi.stubEnv("BROWSER_USE_PROXY_ROTATING_USERNAME", "");
  readBrowserRun.mockResolvedValue({ retriedAsRunId: null, status: "waiting" });
  handOffBrowserRunRetry.mockResolvedValue(true);
  findRecentBrowserUseRunByTaskLine.mockResolvedValue(undefined);
  readBrowserUseRun.mockResolvedValue({ task: "Купи корм\n\nSite: …" });
  createBrowserUseRun.mockResolvedValue({
    id: retryRunId,
    model: "hosted-agent",
    sessionId: "fresh-session",
    status: "running",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the anti-bot retry policy", () => {
  it("backs off over about half an hour and stops at five attempts", async () => {
    const {
      captchaRetryAt,
      captchaRetryWindowMinutes,
      maximumCaptchaAttempts,
    } = await import("@agent/lib/browser-use/captcha-retry");
    const now = new Date("2026-09-23T12:00:00.000Z");
    const waits = [1, 2, 3, 4].map(
      (attempt) =>
        ((captchaRetryAt(attempt, now)?.getTime() ?? 0) - now.getTime()) /
        60_000
    );

    expect(maximumCaptchaAttempts).toBe(5);
    expect(waits).toEqual([2, 5, 9, 14]);
    expect(waits.every((wait, index) => wait >= (waits[index - 1] ?? 0))).toBe(
      true
    );
    expect(captchaRetryWindowMinutes).toBe(30);
    expect(captchaRetryAt(5, now)).toBeUndefined();
    expect(captchaRetryAt(9, now)).toBeUndefined();
  });

  it("replaces the previous retry note instead of piling notes up", async () => {
    const { captchaRetryTask } =
      await import("@agent/lib/browser-use/captcha-retry");

    const second = captchaRetryTask("Купи корм", 2, "(ref 2)");
    const third = captchaRetryTask(second, 3, "(ref 3)");

    expect(second).toContain("attempt 2 of 5");
    expect(third).toContain("attempt 3 of 5");
    expect(third).not.toContain("attempt 2 of 5");
    expect(third).not.toContain("(ref 2)");
    expect(third.endsWith("\n\n(ref 3)")).toBe(true);
    expect(third.startsWith("Купи корм\n\n")).toBe(true);
    expect(third).toContain("about ten seconds");
  });

  it("starts the next attempt in a fresh browser on the same profile", async () => {
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");

    const result = await startCaptchaRetry(parkedRow(1));

    expect(result).toEqual({ runId: retryRunId, status: "started" });
    const input = createBrowserUseRun.mock.calls[0]?.[0];
    expect(input?.sessionId).toBeUndefined();
    expect(input?.profileId).toBe("profile-1");
    expect(input?.task).toContain("attempt 2 of 5");
    expect(input?.proxyCountryCode).toBe("ru");
    // The card was bound before, so the retry binds it again.
    expect(resolveBrowserSecretBindings).toHaveBeenCalledWith(
      { userId: "better-auth:alice", workspaceId: "workspace:alice" },
      { allowPayment: true, site: "https://shop.example" }
    );
    // The new row, the link and the reservation move in one handoff.
    expect(handOffBrowserRunRetry).toHaveBeenCalledOnce();
    expect(handOffBrowserRunRetry.mock.calls[0]?.[0]).toBe(runId);
    expect(handOffBrowserRunRetry.mock.calls[0]?.[1]).toMatchObject({
      captchaAttempt: 2,
      conversationId: "imessage:chat-1",
      id: retryRunId,
      paymentAllowed: true,
      replyAnchorMessageId: "message-1",
      task: "Купи корм",
    });
    expect(cancelBrowserUseRun).not.toHaveBeenCalled();
  });

  it("adopts the run an earlier claim started before it died", async () => {
    findRecentBrowserUseRunByTaskLine.mockResolvedValue({
      id: "orphan-run",
      sessionId: "orphan-session",
    });
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");

    const result = await startCaptchaRetry(parkedRow(1));

    expect(result).toEqual({ runId: "orphan-run", status: "started" });
    // It looked for this very attempt of this very errand…
    const line = findRecentBrowserUseRunByTaskLine.mock.calls[0]?.[0] ?? "";
    expect(line).toContain(runId);
    expect(line).toContain("retry 2");
    // …and handed the errand to it instead of starting a second browser.
    expect(createBrowserUseRun).not.toHaveBeenCalled();
    expect(handOffBrowserRunRetry.mock.calls[0]?.[1]).toMatchObject({
      captchaAttempt: 2,
      id: "orphan-run",
      sessionId: "orphan-session",
    });
  });

  it("writes the line a later claim looks for into the retry's task", async () => {
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");

    await startCaptchaRetry(parkedRow(1));

    const line = findRecentBrowserUseRunByTaskLine.mock.calls[0]?.[0] ?? "";
    const task = createBrowserUseRun.mock.calls[0]?.[0].task ?? "";
    expect(task.split("\n")).toContain(line);
  });

  it("starts nothing for an errand the person already stopped", async () => {
    readBrowserRun.mockResolvedValue({
      retriedAsRunId: null,
      status: "stopped",
    });
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");

    expect(await startCaptchaRetry(parkedRow(1))).toEqual({
      status: "stopped",
    });
    expect(createBrowserUseRun).not.toHaveBeenCalled();
  });

  it("cancels the new run when the errand was stopped while it started", async () => {
    handOffBrowserRunRetry.mockResolvedValue(false);
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");

    expect(await startCaptchaRetry(parkedRow(1))).toEqual({
      status: "stopped",
    });
    expect(cancelBrowserUseRun).toHaveBeenCalledExactlyOnceWith(retryRunId);
    expect(parkBrowserRunForRetry).not.toHaveBeenCalled();
  });

  it("cancels the new run and parks again when the handoff cannot be recorded", async () => {
    handOffBrowserRunRetry.mockRejectedValue(new Error("database is down"));
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");

    expect(await startCaptchaRetry(parkedRow(1))).toEqual({ status: "parked" });
    // No untracked run is left paying in the cloud.
    expect(cancelBrowserUseRun).toHaveBeenCalledExactlyOnceWith(retryRunId);
    expect(parkBrowserRunForRetry).toHaveBeenCalledOnce();
  });

  it("starts nothing once the attempts are used up", async () => {
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");

    expect(await startCaptchaRetry(parkedRow(5))).toEqual({
      status: "exhausted",
    });
    expect(createBrowserUseRun).not.toHaveBeenCalled();
  });

  it("counts a retry that could not start and parks the errand again", async () => {
    createBrowserUseRun.mockRejectedValue(new Error("Browser Use is down"));
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");
    const now = new Date("2026-09-23T12:00:00.000Z");

    const result = await startCaptchaRetry(parkedRow(2), now);

    expect(result).toEqual({ status: "parked" });
    expect(parkBrowserRunForRetry).toHaveBeenCalledExactlyOnceWith(runId, {
      captchaAttempt: 3,
      retryAt: new Date("2026-09-23T12:09:00.000Z"),
    });
    expect(handOffBrowserRunRetry).not.toHaveBeenCalled();
  });

  it("gives up when the last attempt cannot start either", async () => {
    createBrowserUseRun.mockRejectedValue(new Error("Browser Use is down"));
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");

    expect(await startCaptchaRetry(parkedRow(4))).toEqual({
      status: "exhausted",
    });
    expect(parkBrowserRunForRetry).not.toHaveBeenCalled();
  });
});

describe("the retry's exit to the internet", () => {
  it("stays on the hosted pool, which gives a new browser a new address", async () => {
    const { retryProxySettings } = await import("@agent/lib/browser-use/proxy");

    expect(retryProxySettings(2, "token")).toEqual({
      customProxy: undefined,
      proxyCountryCode: "ru",
    });
  });

  it("alternates a fixed proxy of our own with the hosted pool", async () => {
    vi.stubEnv("BROWSER_USE_PROXY_HOST", "proxy.example");
    vi.stubEnv("BROWSER_USE_PROXY_PORT", "8080");
    vi.stubEnv("BROWSER_USE_PROXY_USERNAME", "bro");
    const { retryProxySettings } = await import("@agent/lib/browser-use/proxy");

    expect(retryProxySettings(2, "token").customProxy).toBeUndefined();
    expect(retryProxySettings(3, "token").customProxy).toMatchObject({
      host: "proxy.example",
      port: 8080,
      username: "bro",
    });
  });

  it("asks a rotating provider for a fresh session every attempt", async () => {
    vi.stubEnv("BROWSER_USE_PROXY_HOST", "proxy.example");
    vi.stubEnv("BROWSER_USE_PROXY_PORT", "8080");
    vi.stubEnv("BROWSER_USE_PROXY_USERNAME", "bro");
    vi.stubEnv("BROWSER_USE_PROXY_ROTATING_USERNAME", "bro-session-{session}");
    const { retryProxySettings } = await import("@agent/lib/browser-use/proxy");

    expect(retryProxySettings(2, "abc").customProxy?.username).toBe(
      "bro-session-abc"
    );
    expect(retryProxySettings(3, "def").customProxy?.username).toBe(
      "bro-session-def"
    );
  });
});

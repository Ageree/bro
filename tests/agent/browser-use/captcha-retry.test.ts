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
const createBrowserRun = vi.hoisted(() =>
  vi.fn<
    (
      scope: AccessScope,
      input: { readonly captchaAttempt: number; readonly id: string }
    ) => Promise<void>
  >(() => Promise.resolve())
);
const markBrowserRunRetried = vi.hoisted(() =>
  vi.fn<(runId: string, retryRunId: string) => Promise<void>>(() =>
    Promise.resolve()
  )
);
const parkBrowserRunForRetry = vi.hoisted(() =>
  vi.fn<
    (
      runId: string,
      input: { captchaAttempt: number; retryAt: Date }
    ) => Promise<void>
  >(() => Promise.resolve())
);
const moveSpendReservation = vi.hoisted(() =>
  vi.fn<(from: string, to: string) => Promise<void>>(() => Promise.resolve())
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
  createBrowserUseRun,
  readBrowserUseRun,
}));
vi.mock("@db/services/browser-runs", () => ({
  createBrowserRun,
  markBrowserRunRetried,
  parkBrowserRunForRetry,
}));
vi.mock("@db/services/spending", () => ({ moveSpendReservation }));
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
  readBrowserUseRun.mockResolvedValue({ task: "Купи корм\n\nSite: …" });
  createBrowserUseRun.mockResolvedValue({
    id: retryRunId,
    model: "hosted-agent",
    sessionId: "fresh-session",
    status: "running",
  });
});

afterEach(() => {
  vi.stubEnv("BROWSER_USE_PROXY_HOST", "");
  vi.stubEnv("BROWSER_USE_PROXY_PORT", "");
  vi.stubEnv("BROWSER_USE_PROXY_USERNAME", "");
  vi.stubEnv("BROWSER_USE_PROXY_ROTATING_USERNAME", "");
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

    const second = captchaRetryTask("Купи корм", 2);
    const third = captchaRetryTask(second, 3);

    expect(second).toContain("attempt 2 of 5");
    expect(third).toContain("attempt 3 of 5");
    expect(third).not.toContain("attempt 2 of 5");
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
    expect(createBrowserRun.mock.calls[0]?.[1]).toMatchObject({
      captchaAttempt: 2,
      conversationId: "imessage:chat-1",
      id: retryRunId,
      paymentAllowed: true,
      replyAnchorMessageId: "message-1",
      task: "Купи корм",
    });
    expect(markBrowserRunRetried).toHaveBeenCalledExactlyOnceWith(
      runId,
      retryRunId
    );
    expect(moveSpendReservation).toHaveBeenCalledExactlyOnceWith(
      runId,
      retryRunId
    );
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
    expect(markBrowserRunRetried).not.toHaveBeenCalled();
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

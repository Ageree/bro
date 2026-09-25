import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserUseCreateRunInput } from "@agent/lib/browser-use/client";
import type * as browserUseClient from "@agent/lib/browser-use/client";
import type * as browserUseSecrets from "@agent/lib/browser-use/secrets";
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

vi.mock("@agent/lib/browser-use/client", async (importOriginal) => ({
  BrowserUseError: (await importOriginal<typeof browserUseClient>())
    .BrowserUseError,
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
vi.mock("@agent/lib/browser-use/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof browserUseSecrets>()),
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
    pendingTask: null,
    profileId: "profile-1",
    queueRevision: 0,
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
    // What the person confirmed on the card when the errand started.
    submission: {
      personalData: ["имя", "телефон", "адрес"],
      what: "заказ корма для кота",
      where: "shop.example",
      forWhom: "Алиса",
    },
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
  parkBrowserRunForRetry.mockResolvedValue(true);
  resolveBrowserSecretBindings.mockResolvedValue({ aliases: [], bindings: [] });
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

  it("binds the phone again only where the errand's start was told to sign in with it", async () => {
    const { phoneSignInSentence } =
      await import("@agent/lib/browser-use/secrets");
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");

    readBrowserUseRun.mockResolvedValue({
      task: `Купи корм\n\nNo saved password is available for shop.example. ${phoneSignInSentence}`,
    });
    await startCaptchaRetry(parkedRow(1));
    // An errand a model wrote with the bare alias in it binds no phone.
    readBrowserUseRun.mockResolvedValue({
      task: "Купи корм, войди через signin_phone",
    });
    await startCaptchaRetry(parkedRow(1));

    expect(resolveBrowserSecretBindings.mock.calls[0]?.[1]).toMatchObject({
      phoneSignIn: true,
    });
    expect(resolveBrowserSecretBindings.mock.calls[1]?.[1]).toMatchObject({
      phoneSignIn: false,
    });
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
      // The errand was not composed with the phone, so it stays unbound.
      { allowPayment: true, phoneSignIn: false, site: "https://shop.example" }
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
      // The retry is the same errand, so the person's confirmation stays.
      submission: parkedRow(1).submission,
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

  it("counts a retry Browser Use refused and parks the errand again", async () => {
    const { BrowserUseError } = await import("@agent/lib/browser-use/client");
    createBrowserUseRun.mockRejectedValue(
      new BrowserUseError(400, "/runs", "profile is busy")
    );
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");
    const now = new Date("2026-09-23T12:00:00.000Z");

    const result = await startCaptchaRetry(
      { ...parkedRow(2), completedAt: new Date("2026-09-23T11:58:00.000Z") },
      now
    );

    expect(result).toEqual({ status: "parked" });
    expect(parkBrowserRunForRetry).toHaveBeenCalledExactlyOnceWith(runId, {
      captchaAttempt: 3,
      retryAt: new Date("2026-09-23T12:09:00.000Z"),
    });
    expect(handOffBrowserRunRetry).not.toHaveBeenCalled();
  });

  it.each([
    ["a dropped connection", () => new TypeError("fetch failed")],
    [
      "a 502",
      async () => {
        const { BrowserUseError } =
          await import("@agent/lib/browser-use/client");
        return new BrowserUseError(502, "/runs", "bad gateway");
      },
    ],
  ])(
    "keeps the attempt's line after %s, so the next claim adopts a run it may have started",
    async (_label, failure) => {
      createBrowserUseRun.mockRejectedValue(await failure());
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { startCaptchaRetry } =
        await import("@agent/lib/browser-use/captcha-retry");
      const now = new Date("2026-09-23T12:00:00.000Z");
      const row = {
        ...parkedRow(2),
        completedAt: new Date("2026-09-23T11:58:00.000Z"),
      };

      expect(await startCaptchaRetry(row, now)).toEqual({ status: "parked" });
      // The same number: the next claim looks for this attempt's line.
      expect(parkBrowserRunForRetry).toHaveBeenCalledExactlyOnceWith(runId, {
        captchaAttempt: 2,
        retryAt: new Date("2026-09-23T12:01:00.000Z"),
      });

      // Browser Use did start it: the next claim finds it and hands the
      // errand over instead of opening a second browser.
      createBrowserUseRun.mockClear();
      findRecentBrowserUseRunByTaskLine.mockImplementation((line) =>
        Promise.resolve(
          line ===
            `(Background retry 3 of errand ${runId}; for bookkeeping only.)`
            ? { id: retryRunId, sessionId: "fresh-session" }
            : undefined
        )
      );
      expect(
        await startCaptchaRetry(row, new Date("2026-09-23T12:01:00.000Z"))
      ).toEqual({ runId: retryRunId, status: "started" });
      expect(createBrowserUseRun).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["cannot reach Browser Use", () => new TypeError("fetch failed")],
    [
      "gets a 503",
      async () => {
        const { BrowserUseError } =
          await import("@agent/lib/browser-use/client");
        return new BrowserUseError(503, "/runs", "unavailable");
      },
    ],
    [
      "is rate limited",
      async () => {
        const { BrowserUseError } =
          await import("@agent/lib/browser-use/client");
        return new BrowserUseError(429, "/runs", "slow down");
      },
    ],
  ])(
    "starts nothing and keeps the attempt's number when the lookup after an unclear start %s",
    async (_label, failure) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { startCaptchaRetry } =
        await import("@agent/lib/browser-use/captcha-retry");
      const row = {
        ...parkedRow(2),
        completedAt: new Date("2026-09-23T11:58:00.000Z"),
      };
      // The first claim's create was cut off; Browser Use did start it.
      createBrowserUseRun.mockRejectedValue(new TypeError("fetch failed"));
      expect(
        await startCaptchaRetry(row, new Date("2026-09-23T12:00:00.000Z"))
      ).toEqual({ status: "parked" });

      // The same outage fails the next claim's lookup.
      findRecentBrowserUseRunByTaskLine.mockRejectedValue(await failure());
      parkBrowserRunForRetry.mockClear();
      createBrowserUseRun.mockClear();
      expect(
        await startCaptchaRetry(row, new Date("2026-09-23T12:01:00.000Z"))
      ).toEqual({ status: "parked" });
      expect(createBrowserUseRun).not.toHaveBeenCalled();
      expect(parkBrowserRunForRetry).toHaveBeenCalledExactlyOnceWith(runId, {
        captchaAttempt: 2,
        retryAt: new Date("2026-09-23T12:02:00.000Z"),
      });

      // Once Browser Use answers, the run the cut-off create started is
      // adopted: one browser for the errand, never two.
      findRecentBrowserUseRunByTaskLine.mockImplementation((line) =>
        Promise.resolve(
          line ===
            `(Background retry 3 of errand ${runId}; for bookkeeping only.)`
            ? { id: retryRunId, sessionId: "fresh-session" }
            : undefined
        )
      );
      expect(
        await startCaptchaRetry(row, new Date("2026-09-23T12:02:00.000Z"))
      ).toEqual({ runId: retryRunId, status: "started" });
      expect(createBrowserUseRun).not.toHaveBeenCalled();
      expect(handOffBrowserRunRetry).toHaveBeenCalledWith(
        runId,
        expect.objectContaining({ captchaAttempt: 3, id: retryRunId })
      );
    }
  );

  it("keeps one browser through an outage that fails every read after a cut-off start", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { BrowserUseError } = await import("@agent/lib/browser-use/client");
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");
    // The poller claims the row again at whatever time it was parked for.
    let parked = {
      captchaAttempt: 2,
      retryAt: new Date("2026-09-23T12:00:00.000Z"),
    };
    parkBrowserRunForRetry.mockImplementation((_runId, input) => {
      parked = input;
      return Promise.resolve(true);
    });
    const started: string[] = [];
    let outage = false;
    const unavailable = () =>
      Promise.reject(new BrowserUseError(503, "/runs", "unavailable"));
    createBrowserUseRun.mockImplementation((input) => {
      started.push(input.task.split("\n").at(-1) ?? "");
      // Browser Use starts the run, and the answer never comes back.
      outage = true;
      return Promise.reject(new TypeError("fetch failed"));
    });
    findRecentBrowserUseRunByTaskLine.mockImplementation((line) =>
      outage
        ? unavailable()
        : Promise.resolve(
            started.includes(line)
              ? { id: retryRunId, sessionId: "fresh-session" }
              : undefined
          )
    );
    readBrowserUseRun.mockImplementation(() =>
      outage ? unavailable() : Promise.resolve({ task: "Купи корм" })
    );

    // 12:00 the start is cut off; 12:01–12:04 every read fails; 12:05 Browser
    // Use answers again.
    const statuses: string[] = [];
    for (const minute of [0, 1, 2, 3, 4, 5]) {
      if (minute === 5) outage = false;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each claim sees where the last one parked the row.
      const result = await startCaptchaRetry(
        {
          ...parkedRow(parked.captchaAttempt),
          completedAt: new Date("2026-09-23T11:58:00.000Z"),
        },
        parked.retryAt
      );
      statuses.push(result.status);
    }

    expect(statuses).toEqual([
      "parked",
      "parked",
      "parked",
      "parked",
      "parked",
      "started",
    ]);
    expect(started).toEqual([
      `(Background retry 3 of errand ${runId}; for bookkeeping only.)`,
    ]);
    expect(handOffBrowserRunRetry).toHaveBeenCalledExactlyOnceWith(
      runId,
      expect.objectContaining({ captchaAttempt: 3, id: retryRunId })
    );
  });

  it.each([
    [
      "the errand's own row",
      () =>
        readBrowserRun.mockRejectedValueOnce(
          new Error("connection terminated")
        ),
    ],
    [
      "the previous attempt's task",
      async () => {
        const { BrowserUseError } =
          await import("@agent/lib/browser-use/client");
        readBrowserUseRun.mockRejectedValueOnce(
          new BrowserUseError(503, `/runs/${runId}`, "unavailable")
        );
      },
    ],
    [
      "the person's saved sign-ins",
      () =>
        resolveBrowserSecretBindings.mockRejectedValueOnce(
          new Error("vault unavailable")
        ),
    ],
  ])(
    "starts nothing and keeps the attempt's number when it cannot read %s",
    async (_label, failure) => {
      await failure();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { startCaptchaRetry } =
        await import("@agent/lib/browser-use/captcha-retry");

      const result = await startCaptchaRetry(
        { ...parkedRow(2), completedAt: new Date("2026-09-23T11:58:00.000Z") },
        new Date("2026-09-23T12:00:00.000Z")
      );

      expect(result).toEqual({ status: "parked" });
      expect(createBrowserUseRun).not.toHaveBeenCalled();
      expect(parkBrowserRunForRetry).toHaveBeenCalledExactlyOnceWith(runId, {
        captchaAttempt: 2,
        retryAt: new Date("2026-09-23T12:01:00.000Z"),
      });
    }
  );

  it("counts a failed lookup once the wall is old, so an outage ends the errand", async () => {
    findRecentBrowserUseRunByTaskLine.mockRejectedValue(
      new TypeError("fetch failed")
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");

    const result = await startCaptchaRetry(
      { ...parkedRow(2), completedAt: new Date("2026-09-23T11:20:00.000Z") },
      new Date("2026-09-23T12:00:00.000Z")
    );

    expect(result).toEqual({ status: "parked" });
    expect(createBrowserUseRun).not.toHaveBeenCalled();
    expect(parkBrowserRunForRetry).toHaveBeenCalledExactlyOnceWith(runId, {
      captchaAttempt: 3,
      retryAt: new Date("2026-09-23T12:09:00.000Z"),
    });
  });

  it("counts a start of unknown outcome once the wall is old, so an outage ends the errand", async () => {
    createBrowserUseRun.mockRejectedValue(new TypeError("fetch failed"));
    const { startCaptchaRetry } =
      await import("@agent/lib/browser-use/captcha-retry");
    const now = new Date("2026-09-23T12:00:00.000Z");

    const result = await startCaptchaRetry(
      { ...parkedRow(2), completedAt: new Date("2026-09-23T11:20:00.000Z") },
      now
    );

    expect(result).toEqual({ status: "parked" });
    expect(parkBrowserRunForRetry).toHaveBeenCalledExactlyOnceWith(runId, {
      captchaAttempt: 3,
      retryAt: new Date("2026-09-23T12:09:00.000Z"),
    });
  });

  it("gives up when the last attempt cannot start either", async () => {
    const { BrowserUseError } = await import("@agent/lib/browser-use/client");
    createBrowserUseRun.mockRejectedValue(
      new BrowserUseError(400, "/runs", "profile is busy")
    );
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

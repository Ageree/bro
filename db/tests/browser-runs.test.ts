import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };
const runId = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function browserRunsDatabase() {
  // The spy and the services under test have to come from one module registry,
  // so the reset happens before both are imported.
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const pgliteDatabase = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = pgliteDatabase as never;
  const [Database, scope, browserRuns] = await Promise.all([
    import("@db"),
    import("@db/services/scope"),
    import("@db/services/browser-runs"),
  ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return browserRuns;
}

function conversation() {
  return {
    conversationChannel: "photon" as const,
    conversationId: "imessage:chat-1",
    replyAnchorMessageId: "message-1",
    rootSessionId: "session-1",
    sessionId: "browser-session-1",
    task: "Order the usual",
  };
}

describe("browser run persistence", () => {
  it("keeps one Browser Use profile per workspace", async () => {
    const browserRuns = await browserRunsDatabase();

    expect(await browserRuns.readBrowserProfileId(alice)).toBeUndefined();
    expect(await browserRuns.saveBrowserProfileId(alice, "profile-1")).toBe(
      "profile-1"
    );
    expect(await browserRuns.saveBrowserProfileId(alice, "profile-2")).toBe(
      "profile-1"
    );
    expect(await browserRuns.readBrowserProfileId(bob)).toBeUndefined();
  }, 20_000);

  it("scopes a run to the workspace that started it", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, { ...conversation(), id: runId });

    expect(
      (await browserRuns.readBrowserRunForScope(alice, runId))?.status
    ).toBe("created");
    expect(
      await browserRuns.readBrowserRunForScope(bob, runId)
    ).toBeUndefined();
    expect((await browserRuns.readBrowserRun(runId))?.workspaceId).toBe(
      alice.workspaceId
    );
  }, 20_000);

  it("queues a walled run for its retry and follows the errand to the retry", async () => {
    const browserRuns = await browserRunsDatabase();
    const retryId = "55555555-5555-4555-8555-555555555555";
    const now = new Date("2026-09-23T12:00:00.000Z");
    await browserRuns.createBrowserRun(alice, { ...conversation(), id: runId });
    await browserRuns.claimBrowserRunCompletion(runId, {
      outcome: "Needs: captcha",
      status: "done",
    });
    await browserRuns.parkBrowserRunForRetry(runId, {
      captchaAttempt: 1,
      retryAt: new Date(now.getTime() + 2 * 60_000),
    });

    expect(await browserRuns.claimDueBrowserRunRetries(now, 10)).toEqual([]);
    const later = new Date(now.getTime() + 3 * 60_000);
    const due = await browserRuns.claimDueBrowserRunRetries(later, 10);
    const lease = new Date(later.getTime() + 10 * 60_000);
    expect(due.map((row) => [row.id, row.status, row.retryAt])).toEqual([
      [runId, "waiting", lease],
    ]);
    // Claimed once: a second poll finds nothing while the lease holds…
    expect(await browserRuns.claimDueBrowserRunRetries(later, 10)).toEqual([]);
    // …and a poller that died before the handoff has not lost the errand.
    const reclaimed = await browserRuns.claimDueBrowserRunRetries(lease, 10);
    expect(reclaimed.map((row) => row.id)).toEqual([runId]);

    expect(
      await browserRuns.handOffBrowserRunRetry(runId, {
        ...conversation(),
        captchaAttempt: 2,
        id: retryId,
        sessionId: "browser-session-2",
      })
    ).toBe(true);
    expect((await browserRuns.readBrowserRun(runId))?.retryAt).toBeNull();
    const latest = await browserRuns.readLatestBrowserRunForScope(alice, runId);
    expect(latest?.id).toBe(retryId);
    expect(latest?.captchaAttempt).toBe(2);
    expect(latest?.createdByUserId).toBe(alice.userId);
    expect(
      await browserRuns.readLatestBrowserRunForScope(bob, runId)
    ).toBeUndefined();
    // A run that was handed over is never parked or handed over again.
    expect(
      await browserRuns.parkBrowserRunForRetry(runId, {
        captchaAttempt: 2,
        retryAt: now,
      })
    ).toBe(false);
    expect(await browserRuns.claimDueBrowserRunRetries(lease, 10)).toEqual([]);
  }, 20_000);

  it("lets no retry start for an errand the person stopped", async () => {
    const browserRuns = await browserRunsDatabase();
    const now = new Date("2026-09-23T12:00:00.000Z");
    await browserRuns.createBrowserRun(alice, { ...conversation(), id: runId });
    await browserRuns.claimBrowserRunCompletion(runId, {
      outcome: "Needs: captcha",
      status: "done",
    });
    await browserRuns.parkBrowserRunForRetry(runId, {
      captchaAttempt: 1,
      retryAt: now,
    });
    // The poller claims the retry, then the person cancels before it starts.
    expect(await browserRuns.claimDueBrowserRunRetries(now, 10)).toHaveLength(
      1
    );
    expect(await browserRuns.stopBrowserRunErrand(runId)).toBe(true);

    expect(
      await browserRuns.handOffBrowserRunRetry(runId, {
        ...conversation(),
        captchaAttempt: 2,
        id: "55555555-5555-4555-8555-555555555555",
        sessionId: "browser-session-2",
      })
    ).toBe(false);
    expect(
      await browserRuns.readBrowserRun("55555555-5555-4555-8555-555555555555")
    ).toBeUndefined();
    // Nor can the settle path park it again afterwards.
    expect(
      await browserRuns.parkBrowserRunForRetry(runId, {
        captchaAttempt: 1,
        retryAt: now,
      })
    ).toBe(false);
    expect((await browserRuns.readBrowserRun(runId))?.status).toBe("stopped");
  }, 20_000);

  it("settles a run once and stops listing it as unsettled", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    await browserRuns.updateBrowserRunProgress(runId, {
      liveViewUrl: "https://live.browser-use.test/abc",
    });

    const future = new Date(Date.now() + 60_000);
    expect(
      await browserRuns.takeUnsettledBrowserRuns({
        checkedBefore: future,
        limit: 10,
        staleBefore: future,
      })
    ).toHaveLength(1);

    const claimed = await browserRuns.claimBrowserRunCompletion(runId, {
      outcome: "Result: ordered",
      status: "done",
    });
    const second = await browserRuns.claimBrowserRunCompletion(runId, {
      outcome: "Result: ordered again",
      status: "done",
    });

    expect(claimed?.liveViewUrl).toBe("https://live.browser-use.test/abc");
    expect(claimed?.completedAt).toBeInstanceOf(Date);
    expect(second).toBeUndefined();
    expect(
      await browserRuns.takeUnsettledBrowserRuns({
        checkedBefore: future,
        limit: 10,
        staleBefore: future,
      })
    ).toEqual([]);
    expect((await browserRuns.readBrowserRun(runId))?.outcome).toBe(
      "Result: ordered"
    );
  }, 20_000);

  it("lets only an errand queued before it had a browser go without a session", async () => {
    const browserRuns = await browserRunsDatabase();
    const { sessionId: _sessionId, ...withoutSession } = conversation();

    const refused = await browserRuns
      .createBrowserRun(alice, {
        ...withoutSession,
        id: runId,
        status: "running",
      })
      .catch((cause: unknown) => cause);
    const constraintRefusal = z.object({
      cause: z.object({
        message: z.string().includes("browser_runs_session_id_check"),
      }),
    });
    expect(constraintRefusal.safeParse(refused).success).toBe(true);

    const queued = await browserRuns.createQueuedBrowserRun(alice, {
      ...withoutSession,
      pendingTask: "Order the usual, composed",
      retryAt: new Date(),
    });
    const closed = await browserRuns.closeQueuedBrowserRun(queued.id, {
      outcome: "never started",
      status: "failed",
    });
    expect(closed).toMatchObject({ sessionId: null, status: "failed" });
  }, 20_000);

  it("counts every overdue report, not only the fifty it lists", async () => {
    const browserRuns = await browserRunsDatabase();
    const settled = new Date(Date.now() - 10 * 60_000);
    await Promise.all(
      Array.from({ length: 52 }, (_, index) =>
        browserRuns.createBrowserRun(alice, {
          ...conversation(),
          completedAt: settled,
          id: `overdue-run-${String(index)}`,
          report: "RESULT: done",
          status: "done",
        })
      )
    );

    const overdue = await browserRuns.listOverdueBrowserRunReports(
      new Date(Date.now() - 2 * 60_000)
    );

    expect(overdue).toHaveLength(50);
    expect(overdue[0]?.total).toBe(52);
  }, 20_000);

  it("keeps the plain report with the claim, so a settle cut off after it still reports", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });

    const claimed = await browserRuns.claimBrowserRunCompletion(runId, {
      outcome: "нашёл отели",
      report: "Browser run finished: нашёл отели",
      status: "done",
    });

    expect(claimed).toMatchObject({
      report: "Browser run finished: нашёл отели",
      reportDeliveredAt: null,
    });
    expect(claimed?.reportClaimedAt).toBeInstanceOf(Date);
    // The settler is still adding pictures under its lease.
    expect(await browserRuns.listPendingBrowserRunReports(10)).toEqual([]);
    expect(await browserRuns.hasLiveBrowserRuns()).toBe(false);

    // The settle never came back: once the lease runs out, the plain report
    // is what goes out, and the overdue watch sees it.
    vi.useFakeTimers({ now: Date.now() + 3 * 60_000, toFake: ["Date"] });
    try {
      expect(await browserRuns.listPendingBrowserRunReports(10)).toEqual([
        { id: runId },
      ]);
      expect(await browserRuns.hasLiveBrowserRuns()).toBe(true);
      expect(
        await browserRuns.listOverdueBrowserRunReports(
          new Date(Date.now() - 2 * 60_000)
        )
      ).toMatchObject([{ id: runId }]);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("puts a report whose turn failed back in line, three times at most", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: new Date(),
      id: runId,
      report: "Browser run finished",
      status: "done",
    });

    async function failedTurn(attempt: number) {
      const claimed = await browserRuns.claimBrowserRunReport(runId);
      expect(claimed?.reportAttempts).toBe(attempt);
      // The turn it started is running: no second copy goes out meanwhile.
      await browserRuns.renewBrowserRunReportLease(runId);
      expect(await browserRuns.listPendingBrowserRunReports(10)).toEqual([]);
      expect(await browserRuns.reopenBrowserRunReport(runId)).toEqual({
        retried: true,
      });
      expect(await browserRuns.listPendingBrowserRunReports(10)).toEqual([
        { id: runId },
      ]);
    }
    await failedTurn(1);
    await failedTurn(2);
    await browserRuns.claimBrowserRunReport(runId);
    expect(await browserRuns.reopenBrowserRunReport(runId)).toEqual({
      retried: false,
    });
    // Given up: not sent again, but still owed — the owner hears of it and
    // `browser_task status` hands it over.
    expect(await browserRuns.listPendingBrowserRunReports(10)).toEqual([]);
    expect(
      await browserRuns.listOverdueBrowserRunReports(new Date(Date.now() + 1))
    ).toMatchObject([{ id: runId }]);
  }, 20_000);

  it("waits longer after each failed delivery instead of spending every attempt at once", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: new Date(),
      id: runId,
      report: "Browser run finished",
      status: "done",
    });
    const start = Date.now();
    const pendingAfter = async (seconds: number) => {
      vi.useFakeTimers({ now: start + seconds * 1_000, toFake: ["Date"] });
      try {
        return (await browserRuns.listPendingBrowserRunReports(10)).length > 0;
      } finally {
        vi.useRealTimers();
      }
    };

    // A channel outage: the first send fails, and the poller looks every
    // few seconds.
    await browserRuns.claimBrowserRunReport(runId);
    await browserRuns.releaseBrowserRunReport(runId);
    expect(await pendingAfter(5)).toBe(false);
    expect(await pendingAfter(29)).toBe(false);
    expect(await pendingAfter(31)).toBe(true);

    vi.useFakeTimers({ now: start + 31_000, toFake: ["Date"] });
    try {
      await browserRuns.claimBrowserRunReport(runId);
      await browserRuns.releaseBrowserRunReport(runId);
    } finally {
      vi.useRealTimers();
    }
    // The second wait is twice as long.
    expect(await pendingAfter(31 + 59)).toBe(false);
    expect(await pendingAfter(31 + 61)).toBe(true);
    expect((await browserRuns.readBrowserRun(runId))?.reportAttempts).toBe(2);
  }, 20_000);

  it("holds an accepted report until its queued turn had time to start", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: new Date(),
      id: runId,
      report: "Browser run finished",
      status: "done",
    });
    await browserRuns.claimBrowserRunReport(runId);
    await browserRuns.holdBrowserRunReportForTurn(runId);
    const start = Date.now();

    vi.useFakeTimers({ now: start + 5 * 60_000, toFake: ["Date"] });
    try {
      // Queued behind the person's own long turn: not sent a second time.
      expect(await browserRuns.listPendingBrowserRunReports(10)).toEqual([]);
      expect(
        browserRuns.browserRunReportOwed(
          (await browserRuns.readBrowserRun(runId)) ?? { report: null }
        )
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    vi.useFakeTimers({ now: start + 11 * 60_000, toFake: ["Date"] });
    try {
      // Its turn never started: the report goes out again.
      expect(await browserRuns.listPendingBrowserRunReports(10)).toEqual([
        { id: runId },
      ]);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("retries a report whose one turn failed after minutes behind a long turn of the person's", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: new Date(),
      id: runId,
      report: "Browser run finished",
      status: "done",
    });
    const start = Date.now();
    const at = async <T>(seconds: number, work: () => Promise<T>) => {
      vi.useFakeTimers({ now: start + seconds * 1_000, toFake: ["Date"] });
      try {
        return await work();
      } finally {
        vi.useRealTimers();
      }
    };
    // The poller hands the report over, and keeps coming back while it
    // waits: a hold that expired early let it send again each time, and
    // every hand-over counted towards the three failed turns.
    await at(0, async () => {
      await browserRuns.claimBrowserRunReport(runId);
      await browserRuns.holdBrowserRunReportForTurn(runId);
    });
    for (const seconds of [65, 190]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each poll comes at its own moment on the clock.
      await at(seconds, async () => {
        if (await browserRuns.claimBrowserRunReport(runId)) {
          await browserRuns.holdBrowserRunReportForTurn(runId);
        }
      });
    }

    // The person's turn ends; eve runs the report turn, and it fails once.
    const reopened = await at(240, async () => {
      await browserRuns.renewBrowserRunReportLease(runId);
      return browserRuns.reopenBrowserRunReport(runId);
    });

    expect(reopened).toEqual({ retried: true });
    expect(
      await at(245, () => browserRuns.listPendingBrowserRunReports(10))
    ).toEqual([{ id: runId }]);
  }, 20_000);

  it("keeps the lease of a plain report already sent when the full one is saved", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    await browserRuns.claimBrowserRunCompletion(runId, {
      outcome: "нашёл отели",
      report: "plain report",
      status: "done",
    });

    // The settler finishes before anyone sent the plain report: the full
    // report is free to go at once.
    await browserRuns.saveBrowserRunReport(runId, "full report");
    expect(await browserRuns.listPendingBrowserRunReports(10)).toEqual([
      { id: runId },
    ]);

    // Sent and waiting for its turn, the report is not freed by a late save.
    await browserRuns.claimBrowserRunReport(runId);
    await browserRuns.holdBrowserRunReportForTurn(runId);
    await browserRuns.saveBrowserRunReport(runId, "full report, later");
    expect(await browserRuns.listPendingBrowserRunReports(10)).toEqual([]);
  }, 20_000);

  it("never reopens a report its turn already delivered", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: new Date(),
      id: runId,
      report: "Browser run finished",
      status: "done",
    });
    await browserRuns.claimBrowserRunReport(runId);
    await browserRuns.finishBrowserRunReport(runId);

    expect(await browserRuns.reopenBrowserRunReport(runId)).toBeUndefined();
    expect(await browserRuns.listPendingBrowserRunReports(10)).toEqual([]);
  }, 20_000);

  it("finds the open run of a Browser Use session", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: new Date(),
      id: "finished-run",
      status: "done",
    });

    expect(
      await browserRuns.listOpenBrowserRunIdsInSession("browser-session-1")
    ).toEqual([runId]);
    expect(
      await browserRuns.listOpenBrowserRunIdsInSession("another-session")
    ).toEqual([]);
  }, 20_000);
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("browsers kept for a sign-in", () => {
  it("knows which runs may still hold a browser, and takes the idle ones to stop", async () => {
    const browserRuns = await browserRunsDatabase();
    // Working now, on Госуслуги.
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: "working",
      site: "https://www.gosuslugi.ru",
      status: "running",
    });
    // Settled on a code twenty minutes ago, its page kept for the person.
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: minutesAgo(20),
      id: "kept-for-code",
      sessionId: "session-kept",
      site: "https://www.ozon.ru",
      status: "done",
    });
    // Settled a minute ago: its page is still the person's to use.
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: minutesAgo(1),
      id: "just-settled",
      sessionId: "session-just",
      site: "https://market.yandex.ru",
      status: "done",
    });
    // Settled long ago: the cloud has ended that browser itself.
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: minutesAgo(5 * 60),
      createdAt: minutesAgo(5 * 60 + 5),
      id: "long-gone",
      sessionId: "session-gone",
      site: "https://www.wildberries.ru",
      status: "done",
    });
    // Another workspace's browser is not this one's business.
    await browserRuns.createBrowserRun(bob, {
      ...conversation(),
      id: "bobs",
      site: "https://www.gosuslugi.ru",
      status: "running",
    });

    expect(
      (await browserRuns.listBrowserHoldingRuns(alice.workspaceId))
        .map((run) => run.site)
        .toSorted((left, right) => String(left).localeCompare(String(right)))
    ).toEqual([
      "https://market.yandex.ru",
      "https://www.gosuslugi.ru",
      "https://www.ozon.ru",
    ]);
    expect(
      await browserRuns.listWorkspacesHoldingBrowsers([
        alice.workspaceId,
        "workspace:nobody",
      ])
    ).toEqual([alice.workspaceId]);

    const now = new Date();
    const idle = await browserRuns.takeIdleBrowserRuns(now, 10);
    expect(
      idle.map(({ id, sessionId, workspaceId }) => ({
        id,
        sessionId,
        workspaceId,
      }))
    ).toEqual([
      {
        id: "kept-for-code",
        sessionId: "session-kept",
        workspaceId: alice.workspaceId,
      },
    ]);
    expect(idle[0]?.completedAt).toBeInstanceOf(Date);
    // Taking it claims the page: a follow-up arriving now opens a fresh
    // browser instead of typing into the one being stopped.
    expect(await browserRuns.claimBrowserRunBrowser("kept-for-code")).toBe(
      false
    );
    // A stop that did not happen gives it back for the next tick.
    await browserRuns.unclaimBrowserRunBrowser("kept-for-code", now);
    const later = new Date(now.getTime() + 60_000);
    expect(
      (await browserRuns.takeIdleBrowserRuns(later, 10)).map((run) => run.id)
    ).toEqual(["kept-for-code"]);

    await browserRuns.releaseBrowserRunBrowser("kept-for-code");
    const released = await browserRuns.readBrowserRun("kept-for-code");
    // Released at the claim, not at the stop that followed it.
    expect(released?.browserReleasedAt).toEqual(later);
    // Its live view died with it.
    expect(released?.liveViewUrl).toBeNull();
    expect(await browserRuns.takeIdleBrowserRuns(new Date(), 10)).toEqual([]);
    expect(
      (await browserRuns.listBrowserHoldingRuns(alice.workspaceId)).map(
        (run) => run.site
      )
    ).not.toContain("https://www.ozon.ru");
  }, 20_000);

  it("gives a kept page to one taker, and gives back only its own claim", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: minutesAgo(2),
      id: "kept",
      sessionId: "session-kept",
      status: "done",
    });
    const first = new Date();
    const second = new Date(first.getTime() + 1_000);

    expect(await browserRuns.claimBrowserRunBrowser("kept", first)).toBe(true);
    expect(await browserRuns.claimBrowserRunBrowser("kept", second)).toBe(
      false
    );
    // The second taker cannot undo the first one's claim.
    await browserRuns.unclaimBrowserRunBrowser("kept", second);
    expect(
      (await browserRuns.readBrowserRun("kept"))?.browserReleasedAt
    ).toEqual(first);
    await browserRuns.unclaimBrowserRunBrowser("kept", first);
    expect(
      (await browserRuns.readBrowserRun("kept"))?.browserReleasedAt
    ).toBeNull();
  }, 20_000);

  it("knows when another browser of the workspace is up, and when the profile is in use", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: minutesAgo(16),
      id: "idle",
      sessionId: "session-idle",
      status: "done",
    });
    expect(
      await browserRuns.otherRunHoldsBrowser(alice.workspaceId, "idle")
    ).toBe(false);
    expect(
      await browserRuns.workspaceUsesBrowserProfile(alice.workspaceId)
    ).toBe(true);

    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: "working",
      sessionId: "session-working",
      status: "running",
    });
    expect(
      await browserRuns.otherRunHoldsBrowser(alice.workspaceId, "idle")
    ).toBe(true);
    // Bob's browser is not Alice's.
    expect(await browserRuns.otherRunHoldsBrowser(bob.workspaceId, "x")).toBe(
      false
    );

    await browserRuns.releaseBrowserRunBrowser("idle");
    await browserRuns.releaseBrowserRunBrowser("working");
    expect(
      await browserRuns.workspaceUsesBrowserProfile(alice.workspaceId)
    ).toBe(false);
    // An errand waiting in the queue still starts on the profile.
    await browserRuns.createQueuedBrowserRun(alice, {
      ...conversation(),
      pendingTask: "Закажи корм",
      retryAt: new Date(),
      sessionId: null,
    });
    expect(
      await browserRuns.workspaceUsesBrowserProfile(alice.workspaceId)
    ).toBe(true);
  }, 20_000);

  it("forgets only the profile Browser Use deleted", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.saveBrowserProfileId(alice, "profile-alice");

    // One created since the delete stays.
    await browserRuns.forgetBrowserProfile(alice.workspaceId, "profile-old");
    expect(await browserRuns.readBrowserProfileId(alice)).toBe("profile-alice");
    await browserRuns.forgetBrowserProfile(alice.workspaceId, "profile-alice");
    expect(await browserRuns.readBrowserProfileId(alice)).toBeUndefined();
  }, 20_000);

  it("does not count an errand waiting on its own workspace's sign-in as the service's queue", async () => {
    const browserRuns = await browserRunsDatabase();
    const retryAt = new Date(Date.now() + 60_000);
    const waiting = await browserRuns.createQueuedBrowserRun(alice, {
      ...conversation(),
      pendingTask: "Запиши к терапевту",
      retryAt,
      sessionId: null,
      site: "https://emias.info",
      waitsForAccount: "gosuslugi.ru",
    });
    expect(await browserRuns.countQueuedBrowserRuns()).toBe(0);

    // Its account is free: from here it waits for a browser like any other.
    await browserRuns.parkQueuedBrowserRun(waiting.id, retryAt, {
      waitsForAccount: null,
    });
    expect(await browserRuns.countQueuedBrowserRuns()).toBe(1);
    expect((await browserRuns.readBrowserRun(waiting.id))?.retryAt).toEqual(
      retryAt
    );
  }, 20_000);
});

describe("sign-ins kept in the browser profile", () => {
  async function signInsDatabase() {
    const browserRuns = await browserRunsDatabase();
    const signIns = await import("@db/services/browser-sign-ins");
    return { browserRuns, signIns };
  }

  it("keeps the page a run was signed in on and forgets it when a run meets a sign-in", async () => {
    const { signIns } = await signInsDatabase();
    const first = new Date("2026-09-25T10:00:00.000Z");
    await signIns.recordBrowserSignIn(alice.workspaceId, {
      accountUrl: "https://www.ozon.ru/my/main",
      domain: "ozon.ru",
      now: first,
    });
    // A later run that named no page keeps the one on record.
    const later = new Date("2026-09-25T11:00:00.000Z");
    await signIns.recordBrowserSignIn(alice.workspaceId, {
      accountUrl: undefined,
      domain: "ozon.ru",
      now: later,
    });
    const [kept] = await signIns.readBrowserSignIns(alice.workspaceId, [
      "ozon.ru",
    ]);
    expect(kept).toMatchObject({
      accountUrl: "https://www.ozon.ru/my/main",
      checkedAt: later,
      state: "signed_in",
      usedAt: later,
    });

    await signIns.recordBrowserSignOut(
      alice.workspaceId,
      ["ozon.ru", "wildberries.ru"],
      later
    );
    const records = await signIns.readBrowserSignIns(alice.workspaceId, [
      "ozon.ru",
      "wildberries.ru",
    ]);
    // A site nobody signed in to has nothing to forget.
    expect(records.map((record) => [record.domain, record.state])).toEqual([
      ["ozon.ru", "signed_out"],
    ]);
    expect(
      await signIns.readBrowserSignIns(bob.workspaceId, ["ozon.ru"])
    ).toEqual([]);
  }, 20_000);

  it("lists the sites on record and forgets them, keeping a site the person opted out of", async () => {
    const { signIns } = await signInsDatabase();
    for (const [domain, day] of [
      ["ozon.ru", "2026-09-24"],
      ["yandex.ru", "2026-09-25"],
      ["wildberries.ru", "2026-09-23"],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Records in the order a person would earn them.
      await signIns.recordBrowserSignIn(alice.workspaceId, {
        accountUrl: `https://www.${domain}/my`,
        domain,
        now: new Date(`${day}T10:00:00.000Z`),
      });
    }
    await signIns.recordBrowserSignIn(bob.workspaceId, {
      accountUrl: "https://www.ozon.ru/my",
      domain: "ozon.ru",
      now: new Date("2026-09-25T10:00:00.000Z"),
    });
    await signIns.stopBrowserSignInRefresh(
      alice.workspaceId,
      "ozon.ru",
      new Date("2026-09-26T10:00:00.000Z")
    );

    expect(
      (await signIns.listBrowserSignIns(alice.workspaceId)).map((record) => [
        record.domain,
        record.refreshOptOut,
      ])
    ).toEqual([
      ["yandex.ru", false],
      ["ozon.ru", true],
      ["wildberries.ru", false],
    ]);

    expect(
      (await signIns.forgetBrowserSignIns(alice.workspaceId)).toSorted()
    ).toEqual(["ozon.ru", "wildberries.ru", "yandex.ru"]);
    // «Не заходи в Озон» outlives the forgotten profile.
    expect(
      (await signIns.listBrowserSignIns(alice.workspaceId)).map((record) => [
        record.domain,
        record.state,
        record.refreshOptOut,
      ])
    ).toEqual([["ozon.ru", "signed_out", true]]);
    // Bob's are his.
    expect(await signIns.listBrowserSignIns(bob.workspaceId)).toEqual([
      expect.objectContaining({ domain: "ozon.ru", refreshOptOut: false }),
    ]);
  }, 20_000);

  it("never visits a site again once the person said so, whatever later errands find", async () => {
    const { browserRuns, signIns } = await signInsDatabase();
    const dueBefore = new Date("2026-10-10T10:00:00.000Z");
    const due = () =>
      signIns.listDueBrowserSignInRefreshes({
        dueBefore,
        excludedDomains: [],
        limit: 10,
        usedAfter: new Date("2026-09-01T10:00:00.000Z"),
      });
    await browserRuns.saveBrowserProfileId(alice, "profile-alice");
    // Opted out before any sign-in there: the mark waits for one.
    await signIns.stopBrowserSignInRefresh(
      alice.workspaceId,
      "ozon.ru",
      new Date("2026-09-20T10:00:00.000Z")
    );
    // A later errand signs in there again.
    await signIns.recordBrowserSignIn(alice.workspaceId, {
      accountUrl: "https://www.ozon.ru/my/main",
      domain: "ozon.ru",
      now: new Date("2026-09-25T10:00:00.000Z"),
    });

    expect(await due()).toEqual([]);
    expect(
      await signIns.claimBrowserSignInRefresh(alice.workspaceId, "ozon.ru", {
        dueBefore,
        now: new Date("2026-10-11T10:00:00.000Z"),
      })
    ).toBe(false);
    const [record] = await signIns.readBrowserSignIns(alice.workspaceId, [
      "ozon.ru",
    ]);
    // Still signed in, as far as errands go.
    expect(record).toMatchObject({ refreshOptOut: true, state: "signed_in" });
  }, 20_000);

  it("claims each keep-alive visit once, and only where a profile exists", async () => {
    const { browserRuns, signIns } = await signInsDatabase();
    const now = new Date("2026-09-30T10:00:00.000Z");
    const dueBefore = new Date("2026-09-27T10:00:00.000Z");
    const usedAfter = new Date("2026-08-31T10:00:00.000Z");
    await browserRuns.saveBrowserProfileId(alice, "profile-alice");
    await signIns.recordBrowserSignIn(alice.workspaceId, {
      accountUrl: "https://www.ozon.ru/my/main",
      domain: "ozon.ru",
      now: new Date("2026-09-25T10:00:00.000Z"),
    });
    // Seen yesterday: not due.
    await signIns.recordBrowserSignIn(alice.workspaceId, {
      accountUrl: "https://id.yandex.ru/",
      domain: "yandex.ru",
      now: new Date("2026-09-29T10:00:00.000Z"),
    });
    // Госуслуги is never kept alive.
    await signIns.recordBrowserSignIn(alice.workspaceId, {
      accountUrl: "https://lk.gosuslugi.ru/profile",
      domain: "gosuslugi.ru",
      now: new Date("2026-09-25T10:00:00.000Z"),
    });
    // No profile, so nothing to visit with.
    await signIns.recordBrowserSignIn(bob.workspaceId, {
      accountUrl: "https://www.ozon.ru/my/main",
      domain: "ozon.ru",
      now: new Date("2026-09-25T10:00:00.000Z"),
    });

    const due = await signIns.listDueBrowserSignInRefreshes({
      dueBefore,
      excludedDomains: ["gosuslugi.ru"],
      limit: 10,
      usedAfter,
    });
    expect(due).toEqual([
      {
        accountUrl: "https://www.ozon.ru/my/main",
        domain: "ozon.ru",
        profileId: "profile-alice",
        workspaceId: alice.workspaceId,
      },
    ]);
    expect(
      await signIns.claimBrowserSignInRefresh(alice.workspaceId, "ozon.ru", {
        dueBefore,
        now,
      })
    ).toBe(true);
    // A second tick finds it claimed.
    expect(
      await signIns.claimBrowserSignInRefresh(alice.workspaceId, "ozon.ru", {
        dueBefore,
        now,
      })
    ).toBe(false);
    expect(
      await signIns.listDueBrowserSignInRefreshes({
        dueBefore,
        excludedDomains: ["gosuslugi.ru"],
        limit: 10,
        usedAfter,
      })
    ).toEqual([]);

    await signIns.recordBrowserSignInCheck(alice.workspaceId, "ozon.ru", {
      now,
      signedIn: false,
    });
    const [checked] = await signIns.readBrowserSignIns(alice.workspaceId, [
      "ozon.ru",
    ]);
    expect(checked?.state).toBe("signed_out");
  }, 20_000);
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

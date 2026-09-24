import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
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

    await expect(
      browserRuns.createBrowserRun(alice, {
        ...withoutSession,
        id: runId,
        status: "running",
      })
    ).rejects.toThrow();

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

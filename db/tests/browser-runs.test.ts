import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };
const runId = "11111111-1111-4111-8111-111111111111";

function defined<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

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
      (await browserRuns.resolveBrowserRunForScope(alice, runId))?.requested
        .status
    ).toBe("created");
    expect(
      await browserRuns.resolveBrowserRunForScope(bob, runId)
    ).toBeUndefined();
    expect((await browserRuns.readBrowserRun(runId))?.workspaceId).toBe(
      alice.workspaceId
    );
  }, 20_000);

  it("persists the selected proxy country on the scoped run", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      proxyCountryCode: "us",
    });

    expect(
      (await browserRuns.resolveBrowserRunForScope(alice, runId))?.requested
        .proxyCountryCode
    ).toBe("us");
    expect(
      await browserRuns.resolveBrowserRunForScope(bob, runId)
    ).toBeUndefined();
  }, 20_000);

  it("keeps legacy rows nullable and rejects an invalid country", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, { ...conversation(), id: runId });

    expect(
      (await browserRuns.resolveBrowserRunForScope(alice, runId))?.requested
        .proxyCountryCode
    ).toBeNull();
    await expect(
      browserRuns.createBrowserRun(alice, {
        ...conversation(),
        id: "22222222-2222-4222-8222-222222222222",
        proxyCountryCode: "usa",
      })
    ).rejects.toHaveProperty(
      "cause.message",
      expect.stringContaining("browser_runs_proxy_country_code_check")
    );
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
      await browserRuns.listBrowserRunsForReconciliation({
        limit: 10,
        staleBefore: future,
      })
    ).toHaveLength(1);

    const claimed = await browserRuns.claimBrowserLineageSettlement(
      { runId, rootRunId: runId, lineageRevision: 0 },
      {
        finalNeed: "none",
        finalTaskStatus: "complete",
        outcome: "Result: ordered",
        status: "done",
        verificationReport: null,
      }
    );
    const second = await browserRuns.claimBrowserLineageSettlement(
      { runId, rootRunId: runId, lineageRevision: 0 },
      {
        finalNeed: "none",
        finalTaskStatus: "complete",
        outcome: "Result: ordered again",
        status: "done",
        verificationReport: null,
      }
    );

    expect(claimed?.liveViewUrl).toBe("https://live.browser-use.test/abc");
    expect(claimed?.completedAt).toBeInstanceOf(Date);
    expect(second).toBeUndefined();
    const delivery = await browserRuns.claimBrowserRunDelivery({
      activeRunId: runId,
      lineageRevision: 0,
      rootRunId: runId,
    });
    await browserRuns.acknowledgeBrowserRunDelivery(
      runId,
      defined(delivery, "Expected the delivery claim.").token,
      0
    );
    expect(
      await browserRuns.listBrowserRunsForReconciliation({
        limit: 10,
        staleBefore: future,
      })
    ).toEqual([]);
    expect((await browserRuns.readBrowserRun(runId))?.outcome).toBe(
      "Result: ordered"
    );
  }, 20_000);

  it("resolves an old run id to the current lineage head after a completed errand is reopened", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "done",
      completedAt: new Date(),
    });
    const transition = await browserRuns.claimBrowserLineageTransition({
      activeRunId: runId,
      allowCompleted: true,
      capability: "browse",
      expectedRevision: 0,
      rootRunId: runId,
      task: "continue safely",
      verificationPlan: null,
    });
    const claimedTransition = defined(
      transition,
      "Expected the continuation transition."
    );
    expect(
      await browserRuns.markBrowserLineageCreating(
        runId,
        claimedTransition.token,
        claimedTransition.root.lineageRevision
      )
    ).toBeDefined();
    const childId = "33333333-3333-4333-8333-333333333333";
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: childId,
      parentRunId: runId,
      rootRunId: runId,
      status: "running",
    });
    expect(
      await browserRuns.finishBrowserLineageTransition({
        childId,
        lineageRevision: claimedTransition.root.lineageRevision,
        rootRunId: runId,
        token: claimedTransition.token,
      })
    ).toBeDefined();

    const resolved = await browserRuns.resolveBrowserRunForScope(alice, runId);
    expect(resolved?.active.id).toBe(childId);
    expect(resolved?.root.completedAt).toBeNull();
  }, 20_000);

  it("allows only one repair claim and makes the old callback stale before child creation", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    const first = await browserRuns.claimBrowserRepair({
      activeRunId: runId,
      deadline: new Date(Date.now() + 90_000),
      expectedRevision: 0,
      rootRunId: runId,
      task: "repair marker",
    });
    const duplicate = await browserRuns.claimBrowserRepair({
      activeRunId: runId,
      deadline: new Date(Date.now() + 90_000),
      expectedRevision: 0,
      rootRunId: runId,
      task: "duplicate",
    });
    const staleSettlement = await browserRuns.claimBrowserLineageSettlement(
      { runId, rootRunId: runId, lineageRevision: 0 },
      {
        finalNeed: "none",
        finalTaskStatus: "complete",
        outcome: "late callback",
        status: "done",
        verificationReport: null,
      }
    );

    const claimedRepair = defined(first, "Expected the repair claim.");
    expect(duplicate).toBeUndefined();
    expect(staleSettlement).toBeUndefined();
    expect((await browserRuns.readBrowserRun(runId))?.repairCount).toBe(1);
    await browserRuns.failBrowserLineageTransition(
      runId,
      claimedRepair.token,
      claimedRepair.root.lineageRevision
    );
    expect(await browserRuns.readBrowserRun(runId)).toMatchObject({
      activeRunId: runId,
      lineageState: "active",
      repairState: "failed",
    });
  }, 20_000);

  it("separates settlement from delivery acknowledgement and preserves ambiguity", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    expect(
      await browserRuns.claimBrowserLineageSettlement(
        { runId, rootRunId: runId, lineageRevision: 0 },
        {
          finalNeed: "none",
          finalTaskStatus: "complete",
          outcome: "verified",
          status: "done",
          verificationReport: null,
        }
      )
    ).toBeDefined();
    const delivery = await browserRuns.claimBrowserRunDelivery({
      activeRunId: runId,
      lineageRevision: 0,
      rootRunId: runId,
    });
    expect(delivery).toBeDefined();
    expect(
      await browserRuns.claimBrowserRunDelivery({
        activeRunId: runId,
        lineageRevision: 0,
        rootRunId: runId,
      })
    ).toBeUndefined();
    await browserRuns.markStaleBrowserRunDeliveryAmbiguous({
      claimedBefore: new Date(Date.now() + 1_000),
      rootRunId: runId,
    });
    expect((await browserRuns.readBrowserRun(runId))?.deliveryState).toBe(
      "ambiguous"
    );
    expect(
      await browserRuns.claimBrowserRunDelivery({
        activeRunId: runId,
        lineageRevision: 0,
        rootRunId: runId,
      })
    ).toBeUndefined();
  }, 20_000);

  it("releases a definitely unaccepted delivery without acknowledging it", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    await browserRuns.claimBrowserLineageSettlement(
      { lineageRevision: 0, rootRunId: runId, runId },
      {
        finalNeed: "none",
        finalTaskStatus: "complete",
        outcome: "verified",
        status: "done",
        verificationReport: null,
      }
    );
    const claimed = defined(
      await browserRuns.claimBrowserRunDelivery({
        activeRunId: runId,
        lineageRevision: 0,
        rootRunId: runId,
      }),
      "Expected the delivery claim."
    );
    await browserRuns.releaseBrowserRunDeliveryClaim({
      lineageRevision: 0,
      rootRunId: runId,
      token: claimed.token,
    });
    expect(await browserRuns.readBrowserRun(runId)).toMatchObject({
      deliveryClaimedAt: null,
      deliveryState: "pending",
      deliveryToken: null,
      deliveredAt: null,
    });
  }, 20_000);

  it("lets a user cancellation or amendment invalidate a child that is still being created", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    const first = await browserRuns.claimBrowserLineageTransition({
      activeRunId: runId,
      capability: "browse",
      expectedRevision: 0,
      rootRunId: runId,
      task: "first continuation",
      verificationPlan: null,
    });
    const firstTransition = defined(first, "Expected the first transition.");
    await browserRuns.markBrowserLineageCreating(
      runId,
      firstTransition.token,
      firstTransition.root.lineageRevision
    );
    const amended = await browserRuns.claimBrowserLineageTransition({
      activeRunId: runId,
      allowSupersede: true,
      capability: "prepare",
      expectedRevision: firstTransition.root.lineageRevision,
      rootRunId: runId,
      task: "user amendment",
      verificationPlan: null,
    });
    const amendedTransition = defined(
      amended,
      "Expected the amended transition."
    );
    expect(amendedTransition.root).toMatchObject({
      capability: "prepare",
      verificationPlan: null,
    });
    expect(
      await browserRuns.finishBrowserLineageTransition({
        childId: "late-child",
        lineageRevision: firstTransition.root.lineageRevision,
        rootRunId: runId,
        token: firstTransition.token,
      })
    ).toBeUndefined();
    await browserRuns.cancelBrowserLineage(
      runId,
      amendedTransition.root.lineageRevision
    );
    expect(
      await browserRuns.markBrowserLineageCreating(
        runId,
        amendedTransition.token,
        amendedTransition.root.lineageRevision
      )
    ).toBeUndefined();
    expect((await browserRuns.readBrowserRun(runId))?.status).toBe("stopped");
  }, 20_000);

  it("atomically rejects repair on a settled or already-repaired generation without reopening it", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      completedAt: new Date(),
      id: runId,
      outcome: "already delivered",
      repairCount: 1,
      status: "done",
    });
    const repair = await browserRuns.claimBrowserRepair({
      activeRunId: runId,
      deadline: new Date(Date.now() + 90_000),
      expectedRevision: 0,
      rootRunId: runId,
      task: "must not reopen",
    });
    expect(repair).toBeUndefined();
    const unchanged = await browserRuns.readBrowserRun(runId);
    expect(unchanged?.completedAt).toBeInstanceOf(Date);
    expect(unchanged).toMatchObject({
      activeRunId: runId,
      lineageRevision: 0,
      outcome: "already delivered",
      repairCount: 1,
    });
  }, 20_000);

  it("rejects settlement captured before a user continuation claim", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    const amended = await browserRuns.claimBrowserLineageTransition({
      activeRunId: runId,
      capability: "prepare",
      expectedRevision: 0,
      rootRunId: runId,
      task: "User amendment",
      verificationPlan: null,
    });
    expect(amended?.root.lineageRevision).toBe(1);
    expect(
      await browserRuns.claimBrowserLineageSettlement(
        { lineageRevision: 0, rootRunId: runId, runId },
        {
          finalNeed: "none",
          finalTaskStatus: "complete",
          outcome: "stale",
          status: "done",
          verificationReport: null,
        }
      )
    ).toBeUndefined();
  }, 20_000);

  it("prevents a rejected create cleanup from restoring a lineage cancelled during POST", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    const transition = await browserRuns.claimBrowserLineageTransition({
      activeRunId: runId,
      capability: "browse",
      expectedRevision: 0,
      rootRunId: runId,
      task: "continue",
      verificationPlan: null,
    });
    const creatingTransition = defined(
      transition,
      "Expected the creating transition."
    );
    await browserRuns.markBrowserLineageCreating(
      runId,
      creatingTransition.token,
      creatingTransition.root.lineageRevision
    );
    await browserRuns.cancelBrowserLineage(
      runId,
      creatingTransition.root.lineageRevision
    );
    expect(
      await browserRuns.failBrowserLineageTransition(
        runId,
        creatingTransition.token,
        creatingTransition.root.lineageRevision
      )
    ).toBeUndefined();
    expect(await browserRuns.readBrowserRun(runId)).toMatchObject({
      lineageState: "cancelled",
      status: "stopped",
    });
  }, 20_000);

  it("serializes two orphan recoverers for one creating generation", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    const transition = await browserRuns.claimBrowserLineageTransition({
      activeRunId: runId,
      capability: "browse",
      expectedRevision: 0,
      rootRunId: runId,
      task: "continue",
      verificationPlan: null,
    });
    const recoveringTransition = defined(
      transition,
      "Expected the recovering transition."
    );
    await browserRuns.markBrowserLineageCreating(
      runId,
      recoveringTransition.token,
      recoveringTransition.root.lineageRevision
    );
    const staleBefore = new Date();
    const claims = await Promise.all([
      browserRuns.claimBrowserLineageRecovery({
        lineageRevision: recoveringTransition.root.lineageRevision,
        rootRunId: runId,
        staleBefore,
        token: recoveringTransition.token,
      }),
      browserRuns.claimBrowserLineageRecovery({
        lineageRevision: recoveringTransition.root.lineageRevision,
        rootRunId: runId,
        staleBefore,
        token: recoveringTransition.token,
      }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  }, 20_000);

  it("does not claim or acknowledge delivery across a reopened generation", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    await browserRuns.claimBrowserLineageSettlement(
      { lineageRevision: 0, rootRunId: runId, runId },
      {
        finalNeed: "none",
        finalTaskStatus: "complete",
        outcome: "generation zero",
        status: "done",
        verificationReport: null,
      }
    );
    const transition = await browserRuns.claimBrowserLineageTransition({
      activeRunId: runId,
      allowCompleted: true,
      capability: "browse",
      expectedRevision: 0,
      rootRunId: runId,
      task: "reopen",
      verificationPlan: null,
    });
    expect(transition).toBeDefined();
    expect(
      await browserRuns.claimBrowserRunDelivery({
        activeRunId: runId,
        lineageRevision: 0,
        rootRunId: runId,
      })
    ).toBeUndefined();
    expect(
      await browserRuns.acknowledgeBrowserRunDelivery(runId, "old-token", 0)
    ).toBeUndefined();
  }, 20_000);

  it("clears an expired automatic-repair lease for a later human continuation", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      repairCount: 1,
      repairDeadline: new Date(Date.now() - 60_000),
      repairState: "running",
      repairToken: "old-repair",
      status: "running",
    });
    const transition = await browserRuns.claimBrowserLineageTransition({
      activeRunId: runId,
      capability: "browse",
      expectedRevision: 0,
      rootRunId: runId,
      task: "Human follow-up",
      verificationPlan: null,
    });
    expect(transition?.root).toMatchObject({
      repairCount: 1,
      repairDeadline: null,
      repairState: "none",
      repairToken: null,
    });
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

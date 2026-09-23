/* oxlint-disable eslint/no-await-in-loop -- Migrations and their statements must be applied in order. */
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

const databases: PGlite[] = [];
let migrated: Promise<Blob> | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

const alice = { userId: "alice", workspaceId: "workspace:alice" };
const telegram = {
  conversationChannel: "telegram" as const,
  conversationId: "100::",
};
const photon = {
  conversationChannel: "photon" as const,
  conversationId: "imessage:chat-alice",
};
const now = new Date("2026-09-23T12:00:00.000Z");
const flight = {
  dedupeKey: "flight@2026-09-24T07:40:00Z",
  itemId: "flight",
  source: "calendar" as const,
  threadId: null,
};
const bossMail = {
  dedupeKey: "m1",
  itemId: "m1",
  source: "gmail" as const,
  threadId: "t1",
};

// The first case migrates the shared template database, which takes seconds.
describe("proactive watches", { timeout: 30_000 }, () => {
  it("creates one hidden job per workspace and follows the latest conversation", async () => {
    const { db, jobs, proactive } = await openDatabase();

    expect(await proactive.recordProactiveTarget(alice, telegram, now)).toBe(
      "created"
    );
    expect(await proactive.recordProactiveTarget(alice, telegram, now)).toBe(
      "unchanged"
    );
    expect(await proactive.recordProactiveTarget(alice, photon, now)).toBe(
      "moved"
    );

    // The hidden job is neither a task the person can list nor one the
    // task dispatcher materializes.
    expect(await jobs.listScheduledAgentJobs(alice, photon)).toEqual([]);
    expect(
      await jobs.materializeDueScheduledAgentRuns({
        limit: 10,
        now: new Date("2026-09-30T00:00:00.000Z"),
      })
    ).toEqual([]);

    const [watch] = await proactive.claimDueProactiveWatches({
      leaseForMs: 15 * 60_000,
      limit: 10,
      now,
    });
    expect(watch).toMatchObject({
      createdByUserId: "alice",
      mailCheckedAt: now,
      timezone: null,
      workspaceId: alice.workspaceId,
    });
    const job = await db.query.scheduledAgentJobs.findFirst();
    expect(job).toMatchObject({ ...photon, kind: "proactive" });
  });

  it("leases a due watch until its next check and skips opted-out workspaces", async () => {
    const { proactive, profiles } = await openDatabase();
    await proactive.recordProactiveTarget(alice, telegram, now);
    const lease = { leaseForMs: 15 * 60_000, limit: 10, now };

    expect(await proactive.claimDueProactiveWatches(lease)).toHaveLength(1);
    expect(await proactive.claimDueProactiveWatches(lease)).toEqual([]);
    const later = new Date(now.getTime() + 15 * 60_000);
    expect(
      await proactive.claimDueProactiveWatches({ ...lease, now: later })
    ).toHaveLength(1);

    await profiles.setProactiveMessages(alice, false);
    expect(await profiles.readProactiveMessages(alice)).toBe(false);
    const muchLater = new Date(now.getTime() + 60 * 60_000);
    expect(
      await proactive.claimDueProactiveWatches({ ...lease, now: muchLater })
    ).toEqual([]);

    await profiles.setProactiveMessages(alice, true);
    expect(
      await proactive.claimDueProactiveWatches({ ...lease, now: muchLater })
    ).toHaveLength(1);
  });

  it("hands each signal to one run, once, and waits for an open run", async () => {
    const { jobs, proactive } = await openDatabase();
    await proactive.recordProactiveTarget(alice, telegram, now);
    const [watch] = await proactive.claimDueProactiveWatches({
      leaseForMs: 15 * 60_000,
      limit: 10,
      now,
    });
    if (!watch) throw new Error("Expected a due watch.");

    expect(
      await proactive.filterUnseenProactiveSignals(alice.workspaceId, [
        flight,
        bossMail,
      ])
    ).toEqual([flight, bossMail]);
    const runId = await proactive.queueProactiveRun({
      jobId: watch.jobId,
      mailCheckedAt: now,
      now,
      signals: [flight, bossMail],
      workspaceId: alice.workspaceId,
    });
    expect(runId).toBeDefined();
    if (!runId) return;
    expect(await proactive.listProactiveRunSignals(runId)).toEqual([
      { itemId: "flight", source: "calendar", threadId: null },
      { itemId: "m1", source: "gmail", threadId: "t1" },
    ]);

    const nextMail = { ...bossMail, dedupeKey: "m2", itemId: "m2" };
    expect(
      await proactive.filterUnseenProactiveSignals(alice.workspaceId, [
        flight,
        bossMail,
        nextMail,
      ])
    ).toEqual([nextMail]);

    // While the first run is still queued, a second is not started and the
    // watermark stays where it was.
    const later = new Date(now.getTime() + 15 * 60_000);
    expect(
      await proactive.queueProactiveRun({
        jobId: watch.jobId,
        mailCheckedAt: later,
        now: later,
        signals: [nextMail],
        workspaceId: alice.workspaceId,
      })
    ).toBeUndefined();
    expect(
      await proactive.filterUnseenProactiveSignals(alice.workspaceId, [
        nextMail,
      ])
    ).toEqual([nextMail]);

    // Task and proactive runs are claimed by their own dispatchers.
    expect(
      await jobs.claimReadyScheduledAgentRuns({
        leaseForMs: 60_000,
        limit: 10,
        now: later,
      })
    ).toEqual([]);
    const [claim] = await jobs.claimReadyScheduledAgentRuns({
      kind: "proactive",
      leaseForMs: 60_000,
      limit: 10,
      now: later,
    });
    expect(claim?.run.id).toBe(runId);
    expect(claim?.job.kind).toBe("proactive");
  });

  it("forgets dedupe keys past the retention window", async () => {
    const { proactive } = await openDatabase();
    await proactive.recordProactiveTarget(alice, telegram, now);
    const [watch] = await proactive.claimDueProactiveWatches({
      leaseForMs: 15 * 60_000,
      limit: 10,
      now,
    });
    if (!watch) throw new Error("Expected a due watch.");
    await proactive.queueProactiveRun({
      jobId: watch.jobId,
      mailCheckedAt: now,
      now,
      signals: [bossMail],
      workspaceId: alice.workspaceId,
    });

    await proactive.pruneProactiveSignals(now);
    expect(
      await proactive.filterUnseenProactiveSignals(alice.workspaceId, [
        bossMail,
      ])
    ).toEqual([]);
    await proactive.pruneProactiveSignals(new Date(now.getTime() + 1));
    expect(
      await proactive.filterUnseenProactiveSignals(alice.workspaceId, [
        bossMail,
      ])
    ).toEqual([bossMail]);
  });

  it("fails quietly and holds a finished report back until it may be sent", async () => {
    const { jobs, proactive } = await openDatabase();
    await proactive.recordProactiveTarget(alice, telegram, now);
    const [watch] = await proactive.claimDueProactiveWatches({
      leaseForMs: 15 * 60_000,
      limit: 10,
      now,
    });
    if (!watch) throw new Error("Expected a due watch.");
    const runId = await proactive.queueProactiveRun({
      jobId: watch.jobId,
      mailCheckedAt: now,
      now,
      signals: [flight],
      workspaceId: alice.workspaceId,
    });
    if (!runId) throw new Error("Expected a queued run.");

    // Three failed dispatches dead-letter the run without a report.
    let at = now;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [claim] = await jobs.claimReadyScheduledAgentRuns({
        kind: "proactive",
        leaseForMs: 60_000,
        limit: 10,
        now: at,
      });
      if (!claim?.run.leaseToken) throw new Error("Expected a claim.");
      expect(
        await jobs.releaseScheduledAgentRun(
          runId,
          claim.run.leaseToken,
          "dispatch failed",
          at
        )
      ).toBe(attempt === 2 ? "dead_letter" : "queued");
      at = new Date(at.getTime() + 10 * 60_000);
    }
    expect(await jobs.listRecoverableScheduledReports(at)).toEqual([]);

    // A completed run's report can be held back until quiet hours end.
    const later = new Date(at.getTime() + 60 * 60_000);
    const nextRunId = await proactive.queueProactiveRun({
      jobId: watch.jobId,
      mailCheckedAt: later,
      now: later,
      signals: [bossMail],
      workspaceId: alice.workspaceId,
    });
    if (!nextRunId) throw new Error("Expected a second run.");
    const [claim] = await jobs.claimReadyScheduledAgentRuns({
      kind: "proactive",
      leaseForMs: 60_000,
      limit: 10,
      now: later,
    });
    if (!claim?.run.leaseToken) throw new Error("Expected a claim.");
    await jobs.completeScheduledAgentRun(
      nextRunId,
      claim.run.leaseToken,
      "turn-1",
      {
        kind: "result",
        summary: "Flight SU 2454 leaves at 07:40; check-in is open.",
        urgency: "time_sensitive",
      },
      later
    );
    expect(await jobs.listRecoverableScheduledReports(later)).toEqual([
      {
        conversationChannel: "telegram",
        jobKind: "proactive",
        runId: nextRunId,
        scope: alice,
      },
    ]);
    const morning = new Date(later.getTime() + 8 * 60 * 60_000);
    await jobs.deferScheduledReport(nextRunId, morning, later);
    expect(await jobs.listRecoverableScheduledReports(later)).toEqual([]);
    expect(await jobs.listRecoverableScheduledReports(morning)).toHaveLength(1);
  });
});

// Every case starts from a clone of one migrated database: replaying all
// migrations per case is slow enough to starve the rest of the suite.
async function migrateOnce() {
  const client = new PGlite();
  const migrations = (await readdir(new URL("../migrations", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  for (const migration of migrations) {
    await applyMigration(client, migration);
  }
  const dump = await client.dumpDataDir("none");
  await client.close();
  return dump;
}

async function openDatabase() {
  migrated ??= migrateOnce();
  const client = new PGlite({ loadDataDir: await migrated });
  databases.push(client);
  const pgliteDatabase = drizzle(client, { schema });
  // Modules are reset between cases, so the services must see this copy.
  const Database = await import("@db");
  // SAFETY: PGlite implements the query-builder surface exercised by this service while retaining the shared Drizzle schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The focused test swaps only the database driver.
  vi.spyOn(Database, "db", "get").mockReturnValue(pgliteDatabase as never);
  return {
    db: pgliteDatabase,
    jobs: await import("@db/services/scheduled-agent-jobs"),
    proactive: await import("@db/services/proactive"),
    profiles: await import("@db/services/user-profile"),
  };
}

async function applyMigration(database: PGlite, filename: string) {
  const source = await readFile(
    new URL(`../migrations/${filename}`, import.meta.url),
    "utf8"
  );
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}

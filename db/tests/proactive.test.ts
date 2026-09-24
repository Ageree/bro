/* oxlint-disable eslint/no-await-in-loop -- Migrations and their statements must be applied in order. */
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { queueProactiveRun } from "@db/services/proactive";
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
const web = {
  conversationChannel: "eve" as const,
  conversationId: "web-session-alice",
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

function queuedRunId(result: Awaited<ReturnType<typeof queueProactiveRun>>) {
  return result.status === "queued" ? result.runId : undefined;
}

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
    expect(await jobs.listScheduledAgentJobs(alice)).toEqual([]);
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
    const runId = queuedRunId(
      await proactive.queueProactiveRun({
        maxRunsPerDay: 12,
        jobId: watch.jobId,
        mailCheckedAt: now,
        now,
        signals: [flight, bossMail],
        workspaceId: alice.workspaceId,
      })
    );
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
        maxRunsPerDay: 12,
        jobId: watch.jobId,
        mailCheckedAt: later,
        now: later,
        signals: [nextMail],
        workspaceId: alice.workspaceId,
      })
    ).toEqual({ status: "busy" });
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

  it("stops starting runs for a workspace past its daily cap", async () => {
    const { jobs, proactive } = await openDatabase();
    await proactive.recordProactiveTarget(alice, telegram, now);
    const [watch] = await proactive.claimDueProactiveWatches({
      leaseForMs: 15 * 60_000,
      limit: 10,
      now,
    });
    if (!watch) throw new Error("Expected a due watch.");
    const queue = (at: Date, signal: typeof bossMail | typeof flight) =>
      proactive.queueProactiveRun({
        jobId: watch.jobId,
        mailCheckedAt: at,
        maxRunsPerDay: 1,
        now: at,
        signals: [signal],
        workspaceId: alice.workspaceId,
      });

    const first = queuedRunId(await queue(now, bossMail));
    const [claim] = await jobs.claimReadyScheduledAgentRuns({
      kind: "proactive",
      leaseForMs: 60_000,
      limit: 10,
      now,
    });
    if (!first || !claim?.run.leaseToken) throw new Error("Expected a run.");
    await jobs.completeScheduledAgentRun(
      first,
      claim.run.leaseToken,
      "turn-1",
      { kind: "nothing_to_report", reason: "Nothing new." },
      now
    );

    const nextMail = { ...bossMail, dedupeKey: "m2", itemId: "m2" };
    const evening = new Date(now.getTime() + 8 * 60 * 60_000);
    expect(await queue(evening, nextMail)).toEqual({ status: "capped" });
    // An upcoming event must not wait for the cap to reset: it could start
    // before then.
    const tomorrowFlight = {
      ...flight,
      dedupeKey: "flight@2026-09-24T19:00:00Z",
    };
    const flightRun = queuedRunId(await queue(evening, tomorrowFlight));
    expect(flightRun).toBeDefined();
    const [flightClaim] = await jobs.claimReadyScheduledAgentRuns({
      kind: "proactive",
      leaseForMs: 60_000,
      limit: 10,
      now: evening,
    });
    if (!flightRun || !flightClaim?.run.leaseToken) {
      throw new Error("Expected the flight run to be claimed.");
    }
    await jobs.completeScheduledAgentRun(
      flightRun,
      flightClaim.run.leaseToken,
      "turn-2",
      { kind: "nothing_to_report", reason: "Handled." },
      evening
    );
    // The flight run counts too: the cap stays on until a day after it.
    const firstExpired = new Date(now.getTime() + 24 * 60 * 60_000 + 60_000);
    expect(await queue(firstExpired, nextMail)).toEqual({ status: "capped" });
    const nextDay = new Date(evening.getTime() + 24 * 60 * 60_000 + 60_000);
    expect(await queue(nextDay, nextMail)).toMatchObject({
      status: "queued",
    });
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
      maxRunsPerDay: 12,
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
    const runId = queuedRunId(
      await proactive.queueProactiveRun({
        maxRunsPerDay: 12,
        jobId: watch.jobId,
        mailCheckedAt: now,
        now,
        signals: [flight],
        workspaceId: alice.workspaceId,
      })
    );
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
    const nextRunId = queuedRunId(
      await proactive.queueProactiveRun({
        maxRunsPerDay: 12,
        jobId: watch.jobId,
        mailCheckedAt: later,
        now: later,
        signals: [bossMail],
        workspaceId: alice.workspaceId,
      })
    );
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

  it("closes a run parked on a question when its report is dropped", async () => {
    const { db, jobs, proactive } = await openDatabase();
    await proactive.recordProactiveTarget(alice, telegram, now);
    const [watch] = await proactive.claimDueProactiveWatches({
      leaseForMs: 15 * 60_000,
      limit: 10,
      now,
    });
    if (!watch) throw new Error("Expected a due watch.");
    const runId = queuedRunId(
      await proactive.queueProactiveRun({
        maxRunsPerDay: 12,
        jobId: watch.jobId,
        mailCheckedAt: now,
        now,
        signals: [flight],
        workspaceId: alice.workspaceId,
      })
    );
    const [claim] = await jobs.claimReadyScheduledAgentRuns({
      kind: "proactive",
      leaseForMs: 60_000,
      limit: 10,
      now,
    });
    if (!runId || !claim?.run.leaseToken) throw new Error("Expected a claim.");
    await jobs.waitForScheduledAgentRunInput(runId, claim.run.leaseToken, [
      {
        action: {
          callId: "call-question",
          input: { prompt: "Check you in?" },
          kind: "tool-call" as const,
          toolName: "ask_question",
        },
        allowFreeform: true,
        kind: "question" as const,
        prompt: "Check you in?",
        requestId: "request-question",
      },
    ]);
    const report = await jobs.claimScheduledReport(runId, now);
    if (!report?.run.reportLeaseToken) throw new Error("Expected a report.");

    expect(
      await jobs.dropScheduledReport(runId, report.run.reportLeaseToken, now)
    ).toBe(true);
    expect(
      await db.query.scheduledAgentRuns.findFirst({
        columns: {
          pendingInputRequests: true,
          reportStatus: true,
          status: true,
        },
      })
    ).toEqual({
      pendingInputRequests: null,
      reportStatus: "suppressed",
      status: "completed",
    });
    expect(
      await jobs.listRecoverableScheduledReports(
        new Date(now.getTime() + 60 * 60_000)
      )
    ).toEqual([]);
  });
});

describe("remembered chats", { timeout: 30_000 }, () => {
  it("keeps the messenger and the web chat apart, preferring the messenger", async () => {
    const { db, proactive } = await openDatabase();

    expect(await proactive.recordProactiveTarget(alice, web, now)).toBe(
      "created"
    );
    expect(await proactive.recordProactiveTarget(alice, telegram, now)).toBe(
      "moved"
    );
    expect(await proactive.recordProactiveTarget(alice, web, now)).toBe(
      "unchanged"
    );
    const newerWeb = { ...web, conversationId: "web-session-alice-2" };
    expect(await proactive.recordProactiveTarget(alice, newerWeb, now)).toBe(
      "remembered"
    );
    expect(await proactive.recordProactiveTarget(alice, photon, now)).toBe(
      "moved"
    );

    const watch = await db.query.proactiveWatches.findFirst({
      with: { job: true },
    });
    expect(watch).toMatchObject({
      job: photon,
      messengerChannel: "photon",
      messengerConversationId: photon.conversationId,
      webConversationId: newerWeb.conversationId,
    });
  });

  it("remembers both chats when they start talking at the same moment", async () => {
    const { db, proactive } = await openDatabase();

    await Promise.all([
      proactive.recordProactiveTarget(alice, web, now),
      proactive.recordProactiveTarget(alice, telegram, now),
    ]);

    const watch = await db.query.proactiveWatches.findFirst({
      with: { job: true },
    });
    expect(watch).toMatchObject({
      job: telegram,
      messengerConversationId: telegram.conversationId,
      webConversationId: web.conversationId,
    });
    expect(await db.query.scheduledAgentJobs.findMany()).toHaveLength(1);
  });

  it("recovers the messenger of a person whose target had moved to the web chat", async () => {
    const client = new PGlite();
    databases.push(client);
    const migrations = (
      await readdir(new URL("../migrations", import.meta.url))
    )
      .filter((name) => name.endsWith(".sql"))
      .toSorted();
    const sources = await Promise.all(
      migrations.map((name) =>
        readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")
      )
    );
    const index = sources.findIndex((source) =>
      source.includes('ADD COLUMN IF NOT EXISTS "web_conversation_id"')
    );
    expect(index).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, index)) {
      await applyMigration(client, migration);
    }
    await client.exec(`
      INSERT INTO "user" ("id", "name", "email") VALUES ('bob', 'Bob', 'bob@example.com');
      INSERT INTO workspaces ("id") VALUES ('w-alice'), ('w-bob'), ('w-carol'), ('w-dave');
      INSERT INTO workspace_memberships ("workspace_id", "user_id", "role") VALUES
        ('w-alice', 'alice', 'owner'), ('w-bob', 'bob', 'owner'),
        ('w-carol', 'carol', 'owner'), ('w-dave', 'dave', 'owner');
      INSERT INTO scheduled_agent_jobs
        ("id", "workspace_id", "created_by_user_id", "kind", "prompt", "conversation_channel", "conversation_id", "timing", "updated_at")
      VALUES
        ('00000000-0000-4000-8000-00000000000a', 'w-alice', 'alice', 'proactive', 'check', 'eve', 'web-alice', '{}', '2026-09-20'),
        ('00000000-0000-4000-8000-00000000000b', 'w-alice', 'alice', 'task', 'pill', 'telegram', '100::', '{}', '2026-09-01'),
        ('00000000-0000-4000-8000-00000000000c', 'w-bob', 'bob', 'proactive', 'check', 'eve', 'web-bob', '{}', '2026-09-20'),
        ('00000000-0000-4000-8000-00000000000d', 'w-carol', 'carol', 'proactive', 'check', 'telegram', '200::', '{}', '2026-09-20'),
        ('00000000-0000-4000-8000-00000000000e', 'w-dave', 'dave', 'proactive', 'check', 'eve', 'web-dave', '{}', '2026-09-20');
      INSERT INTO proactive_watches ("workspace_id", "created_by_user_id", "job_id", "mail_checked_at", "next_check_at") VALUES
        ('w-alice', 'alice', '00000000-0000-4000-8000-00000000000a', now(), now()),
        ('w-bob', 'bob', '00000000-0000-4000-8000-00000000000c', now(), now()),
        ('w-carol', 'carol', '00000000-0000-4000-8000-00000000000d', now(), now()),
        ('w-dave', 'dave', '00000000-0000-4000-8000-00000000000e', now(), now());
      INSERT INTO browser_runs ("id", "workspace_id", "created_by_user_id", "task", "status", "conversation_channel", "conversation_id", "created_at")
      VALUES ('run-1', 'w-alice', 'alice', 'errand', 'done', 'photon', 'imessage:alice', '2026-09-10');
      INSERT INTO channel_identities ("channel", "external_user_id", "chat_id", "user_id", "workspace_id")
      VALUES ('telegram', 'tg-bob', '300', 'bob', 'w-bob');
    `);

    // Applied twice: the second run changes nothing.
    await applyMigration(client, migrations[index] ?? "");
    await applyMigration(client, migrations[index] ?? "");

    const { rows } = await client.query<{
      conversation_channel: string;
      conversation_id: string;
      messenger_channel: string | null;
      messenger_conversation_id: string | null;
      web_conversation_id: string | null;
      workspace_id: string;
    }>(`
      SELECT "watch"."workspace_id", "watch"."messenger_channel",
        "watch"."messenger_conversation_id", "watch"."web_conversation_id",
        "job"."conversation_channel", "job"."conversation_id"
      FROM proactive_watches AS "watch"
      JOIN scheduled_agent_jobs AS "job" ON "job"."id" = "watch"."job_id"
      ORDER BY "watch"."workspace_id"
    `);
    expect(rows).toEqual([
      // The errand in iMessage is newer than the Telegram schedule.
      {
        conversation_channel: "photon",
        conversation_id: "imessage:alice",
        messenger_channel: "photon",
        messenger_conversation_id: "imessage:alice",
        web_conversation_id: "web-alice",
        workspace_id: "w-alice",
      },
      // A linked Telegram account is a messenger too.
      {
        conversation_channel: "telegram",
        conversation_id: "300::",
        messenger_channel: "telegram",
        messenger_conversation_id: "300::",
        web_conversation_id: "web-bob",
        workspace_id: "w-bob",
      },
      {
        conversation_channel: "telegram",
        conversation_id: "200::",
        messenger_channel: "telegram",
        messenger_conversation_id: "200::",
        web_conversation_id: null,
        workspace_id: "w-carol",
      },
      // No messenger anywhere: the web chat stays the target.
      {
        conversation_channel: "eve",
        conversation_id: "web-dave",
        messenger_channel: null,
        messenger_conversation_id: null,
        web_conversation_id: "web-dave",
        workspace_id: "w-dave",
      },
    ]);
  });
});

describe("waking the checks when Google connects", { timeout: 30_000 }, () => {
  it("brings the next check forward for a watch parked on a missing grant", async () => {
    const { proactive } = await openDatabase();
    await proactive.recordProactiveTarget(alice, web, now);
    const lease = { leaseForMs: 15 * 60_000, limit: 10, now };
    expect(await proactive.claimDueProactiveWatches(lease)).toHaveLength(1);
    // The probe found no grant, so the next look is hours away.
    await proactive.deferProactiveWatch(
      alice.workspaceId,
      new Date(now.getTime() + 6 * 60 * 60_000),
      "disconnected"
    );
    const connectedAt = new Date(now.getTime() + 20 * 60_000);
    const later = { ...lease, now: connectedAt };
    expect(await proactive.claimDueProactiveWatches(later)).toEqual([]);

    expect(await proactive.wakeProactiveWatch(alice, connectedAt)).toBe(true);

    expect(await proactive.claimDueProactiveWatches(later)).toMatchObject([
      { googleState: "unknown", workspaceId: alice.workspaceId },
    ]);
  });

  it("leaves a connected watch on its own cadence", async () => {
    const { proactive } = await openDatabase();
    await proactive.recordProactiveTarget(alice, web, now);
    await proactive.advanceProactiveWatermark(alice.workspaceId, now);
    const lease = { leaseForMs: 15 * 60_000, limit: 10, now };
    expect(await proactive.claimDueProactiveWatches(lease)).toHaveLength(1);

    // Its next check time is the live lease of the check in progress.
    expect(await proactive.wakeProactiveWatch(alice, now)).toBe(false);
    expect(await proactive.claimDueProactiveWatches(lease)).toEqual([]);
    // A workspace that never talked to Bro has nothing to wake.
    expect(
      await proactive.wakeProactiveWatch({ workspaceId: "workspace:bob" }, now)
    ).toBe(false);
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

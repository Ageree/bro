/* oxlint-disable eslint/no-await-in-loop -- Migrations and their statements must be applied in order. */
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import * as Database from "@db";
import * as schema from "../schema";

const databases: PGlite[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("scheduled agent jobs", () => {
  it("materializes one occurrence, leases its worker, and persists reporting", async () => {
    const client = new PGlite();
    databases.push(client);
    // Every migration, in order: a later one may backfill from any table.
    const migrations = (
      await readdir(new URL("../migrations", import.meta.url))
    )
      .filter((name) => name.endsWith(".sql"))
      .toSorted();
    for (const migration of migrations) {
      await applyMigration(client, migration);
    }

    const pgliteDatabase = drizzle(client, { schema });
    // SAFETY: PGlite implements the query-builder surface exercised by this service while retaining the shared Drizzle schema.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The focused test swaps only the database driver.
    vi.spyOn(Database, "db", "get").mockReturnValue(pgliteDatabase as never);
    const scope = await import("@db/services/scope");
    const jobs = await import("@db/services/scheduled-agent-jobs");
    const leases = await import("@db/services/scheduled-agent-run-leases");
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    const aliceConversation = {
      conversationChannel: "photon" as const,
      conversationId: "imessage:chat-alice",
    };
    const bobConversation = {
      conversationChannel: "photon" as const,
      conversationId: "imessage:chat-bob",
    };
    await scope.ensureScope(alice);
    await scope.ensureScope(bob);

    const now = new Date("2026-09-01T12:00:00.000Z");
    const created = await jobs.createScheduledAgentJob(
      alice,
      {
        ...aliceConversation,
        missedRunPolicy: "run_latest",
        prompt: "Check for a material price change.",
        timing: {
          anchoredAt: "2026-09-01T13:00:00.000Z",
          everyMinutes: 60,
          kind: "interval",
        },
      },
      now
    );
    expect(await jobs.listScheduledAgentJobs(bob)).toEqual([]);
    expect(await jobs.listScheduledAgentJobs(alice)).toEqual([
      { ...created, latestRun: null },
    ]);
    await jobs.updateScheduledAgentJob(
      alice,
      created.id,
      { prompt: "Check for a meaningful price change." },
      new Date("2026-09-01T12:30:00.000Z")
    );
    expect(await jobs.listScheduledAgentJobs(alice)).toEqual([
      expect.objectContaining({
        nextRunAt: new Date("2026-09-01T13:00:00.000Z"),
        prompt: "Check for a meaningful price change.",
      }),
    ]);

    const dueAt = new Date("2026-09-01T13:00:00.000Z");
    await jobs.materializeDueScheduledAgentRuns({ limit: 25, now: dueAt });
    expect(
      await jobs.materializeDueScheduledAgentRuns({ limit: 25, now: dueAt })
    ).toEqual([]);
    let [claim] = await jobs.claimReadyScheduledAgentRuns({
      leaseForMs: 21_600_000,
      limit: 25,
      now: dueAt,
    });
    if (!claim?.run.leaseToken) throw new Error("Expected one leased run.");
    expect(claim).toMatchObject({
      job: { id: created.id, ...aliceConversation },
      run: { attempts: 1, scheduledFor: dueAt, startedAt: null },
    });
    expect(
      await jobs.claimReadyScheduledAgentRuns({
        leaseForMs: 21_600_000,
        limit: 25,
        now: dueAt,
      })
    ).toEqual([]);

    expect(
      await jobs.setScheduledRunSession(
        claim.run.id,
        claim.run.leaseToken,
        "worker-session"
      )
    ).toBe(true);
    const workerStartedAt = new Date("2026-09-01T13:00:05.000Z");
    expect(
      await jobs.markScheduledAgentRunStarted(
        claim.run.id,
        claim.run.leaseToken,
        "worker-session",
        21_600_000,
        workerStartedAt
      )
    ).toBe(true);
    expect(
      await leases.isScheduledAgentRunLeaseActive(
        claim.run.id,
        claim.run.leaseToken,
        new Date("2026-09-01T13:00:06.000Z")
      )
    ).toBe(true);
    expect(
      await jobs.markScheduledAgentRunStarted(
        claim.run.id,
        claim.run.leaseToken,
        "worker-session",
        21_600_000,
        new Date("2026-09-01T13:00:10.000Z")
      )
    ).toBe(true);
    expect(
      await jobs.markScheduledAgentRunStarted(
        claim.run.id,
        "00000000-0000-4000-8000-000000000099",
        "stale-worker-session",
        21_600_000,
        workerStartedAt
      )
    ).toBe(false);
    const [listedJob] = await jobs.listScheduledAgentJobs(alice);
    expect(listedJob?.latestRun).toMatchObject({
      id: claim.run.id,
      startedAt: workerStartedAt,
      status: "running",
      workerSessionId: "worker-session",
    });
    const question = {
      action: {
        callId: "call-question",
        input: { prompt: "Which airport should I use?" },
        kind: "tool-call" as const,
        toolName: "ask_question",
      },
      allowFreeform: true,
      kind: "question" as const,
      prompt: "Which airport should I use?",
      requestId: "request-question",
    };
    const waiting = await jobs.waitForScheduledAgentRunInput(
      claim.run.id,
      claim.run.leaseToken,
      [question],
      new Date("2026-09-01T13:01:00.000Z")
    );
    expect(waiting).toMatchObject({
      pendingInputRequests: [question],
      reportSequence: 1,
      reportStatus: "pending",
      status: "waiting_for_input",
    });
    expect(
      await jobs.claimReadyScheduledAgentRuns({
        leaseForMs: 21_600_000,
        limit: 25,
        now: new Date("2026-09-02T13:00:00.000Z"),
      })
    ).toEqual([]);
    const questionReport = await jobs.claimScheduledReport(
      claim.run.id,
      new Date("2026-09-01T13:01:30.000Z")
    );
    if (!questionReport?.run.reportLeaseToken) {
      throw new Error("Expected the pending question to be reportable.");
    }
    await jobs.finalizeScheduledReport(
      claim.run.id,
      questionReport.run.reportLeaseToken,
      "suppressed"
    );
    expect(
      await jobs.listRecoverableScheduledReports(
        new Date("2026-09-01T13:06:00.000Z")
      )
    ).toEqual([]);
    expect(
      await jobs.listRecoverableScheduledReports(
        new Date("2026-09-01T13:07:00.000Z")
      )
    ).toEqual([
      {
        conversationChannel: "photon",
        jobKind: "task",
        runId: claim.run.id,
        scope: alice,
      },
    ]);
    const retriedQuestionReport = await jobs.claimScheduledReport(
      claim.run.id,
      new Date("2026-09-01T13:07:00.000Z")
    );
    if (!retriedQuestionReport?.run.reportLeaseToken) {
      throw new Error(
        "Expected the unanswered question to be reportable again."
      );
    }
    await jobs.finalizeScheduledReport(
      claim.run.id,
      retriedQuestionReport.run.reportLeaseToken,
      "delivered"
    );
    expect(
      await jobs.getScheduledAgentRunInput(bob, claim.run.id)
    ).toBeUndefined();
    expect(
      await jobs.getScheduledAgentRunInput(alice, claim.run.id)
    ).toMatchObject({
      leaseToken: claim.run.leaseToken,
      pendingInputRequests: [question],
    });
    const answer = [{ requestId: "request-question", text: "LGA" }];
    expect(
      await jobs.submitScheduledAgentRunAnswer(
        claim.run.id,
        "00000000-0000-4000-8000-000000000099",
        answer
      )
    ).toBe(false);
    expect(
      await jobs.submitScheduledAgentRunAnswer(
        claim.run.id,
        claim.run.leaseToken,
        answer,
        new Date("2026-09-01T13:01:50.000Z")
      )
    ).toBe(true);
    const answered = await Promise.all([
      jobs.claimAnsweredScheduledAgentRuns({
        limit: 25,
        now: new Date("2026-09-01T13:02:00.000Z"),
      }),
      jobs.claimAnsweredScheduledAgentRuns({
        limit: 25,
        now: new Date("2026-09-01T13:02:00.000Z"),
      }),
    ]);
    const answeredRuns = answered.flat().map(({ run }) => run);
    expect(answeredRuns).toHaveLength(1);
    expect(answeredRuns[0]).toMatchObject({
      inputResponses: answer,
      pendingInputRequests: [question],
      status: "running",
    });
    await jobs.finishScheduledAgentRunInput(
      claim.run.id,
      claim.run.leaseToken,
      new Date("2026-09-01T13:02:01.000Z")
    );
    expect(
      await jobs.claimReadyScheduledAgentRuns({
        leaseForMs: 21_600_000,
        limit: 25,
        now: new Date("2026-09-01T19:03:00.000Z"),
      })
    ).toEqual([]);
    expect(
      await jobs.releaseScheduledAgentRun(
        claim.run.id,
        claim.run.leaseToken,
        "Worker failed after resumption.",
        new Date("2026-09-01T19:03:00.000Z")
      )
    ).toBe("queued");
    expect(
      await jobs.claimReadyScheduledAgentRuns({
        leaseForMs: 21_600_000,
        limit: 25,
        now: new Date("2026-09-01T19:07:00.000Z"),
      })
    ).toEqual([]);
    const [recoveredWorker] = await jobs.claimReadyScheduledAgentRuns({
      leaseForMs: 21_600_000,
      limit: 25,
      now: new Date("2026-09-01T19:08:00.000Z"),
    });
    if (!recoveredWorker?.run.leaseToken) {
      throw new Error("Expected the interrupted worker to be reclaimed.");
    }
    expect(recoveredWorker.run).toMatchObject({
      attempts: 2,
      startedAt: null,
      workerSessionId: "worker-session",
    });
    claim = recoveredWorker;
    await jobs.setScheduledRunSession(
      claim.run.id,
      claim.run.leaseToken,
      "replacement-worker-session"
    );
    expect(
      await jobs.deferScheduledAgentRunCompletion(
        claim.run.id,
        claim.run.leaseToken,
        "turn-1",
        new Date("2026-09-01T13:01:59.000Z")
      )
    ).toBe(true);
    expect(
      await jobs.completeScheduledAgentRun(
        claim.run.id,
        claim.run.leaseToken,
        "turn-1",
        {
          kind: "result",
          summary: "Browser research is still running.",
          urgency: "normal",
        },
        new Date("2026-09-01T13:02:00.000Z")
      )
    ).toEqual({ status: "deferred" });
    expect(
      await jobs.completeScheduledAgentRun(
        claim.run.id,
        claim.run.leaseToken,
        "turn-2",
        {
          kind: "nothing_to_report",
          reason: "Another background task is still running.",
        },
        new Date("2026-09-01T13:02:01.000Z")
      )
    ).toEqual({ status: "deferred" });
    const completed = await jobs.completeScheduledAgentRun(
      claim.run.id,
      claim.run.leaseToken,
      "turn-3",
      {
        kind: "result",
        summary: "The price fell to $250.",
        urgency: "normal",
      },
      new Date("2026-09-01T13:02:02.000Z")
    );
    expect(completed).toMatchObject({
      status: "completed",
      run: {
        deferredCompletionTurnId: null,
        reportSequence: 2,
        reportStatus: "pending",
        status: "completed",
        workerSessionId: "replacement-worker-session",
      },
    });
    const report = await jobs.claimScheduledReport(claim.run.id, dueAt);
    expect(report).toMatchObject({
      job: { id: created.id },
      run: { reportStatus: "queued" },
    });
    const recovered = await Promise.all([
      jobs.listRecoverableScheduledReports(
        new Date("2026-09-01T13:10:00.000Z")
      ),
      jobs.listRecoverableScheduledReports(
        new Date("2026-09-01T13:10:00.000Z")
      ),
    ]);
    expect(recovered.flat().map(({ runId }) => runId)).toContain(claim.run.id);
    const competingClaims = await Promise.all([
      jobs.claimScheduledReport(claim.run.id, dueAt),
      jobs.claimScheduledReport(claim.run.id, dueAt),
    ]);
    expect(competingClaims.filter(Boolean)).toHaveLength(1);
    const currentReportLease = competingClaims.find(
      (candidate) => candidate !== undefined
    )?.run.reportLeaseToken;
    if (!currentReportLease) throw new Error("Expected one report lease.");
    await jobs.finalizeScheduledReport(
      claim.run.id,
      "00000000-0000-4000-8000-000000000099",
      "delivered"
    );
    expect(
      await jobs.listRecoverableScheduledReports(
        new Date("2026-09-01T13:04:00.000Z")
      )
    ).toEqual([]);
    await jobs.finalizeScheduledReport(
      claim.run.id,
      currentReportLease,
      "delivered"
    );
    expect(await jobs.listRecoverableScheduledReports(dueAt)).toEqual([]);

    expect(
      await jobs.updateScheduledAgentJob(bob, created.id, {
        status: "paused",
      })
    ).toBeUndefined();
    expect(await jobs.listScheduledAgentJobs(alice)).toEqual([
      expect.objectContaining({
        nextRunAt: new Date("2026-09-01T14:00:00.000Z"),
        status: "active",
      }),
    ]);
    await jobs.updateScheduledAgentJob(alice, created.id, {
      status: "paused",
    });
    await jobs.createScheduledAgentJob(
      bob,
      {
        ...bobConversation,
        missedRunPolicy: "run_latest",
        prompt: "Check the hourly value.",
        timing: {
          anchoredAt: "2026-09-01T13:00:00.000Z",
          everyMinutes: 60,
          kind: "interval",
        },
      },
      now
    );

    const recoveredAt = new Date("2026-09-08T13:30:00.000Z");
    await jobs.materializeDueScheduledAgentRuns({
      limit: 25,
      now: recoveredAt,
    });
    let [latestClaim] = await jobs.claimReadyScheduledAgentRuns({
      leaseForMs: 21_600_000,
      limit: 25,
      now: recoveredAt,
    });

    expect(latestClaim).toMatchObject({
      job: { nextRunAt: new Date("2026-09-08T14:00:00.000Z") },
      run: { scheduledFor: new Date("2026-09-08T13:00:00.000Z") },
    });
    let retryAt = recoveredAt;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (!latestClaim?.run.leaseToken) {
        throw new Error("Expected a leased run.");
      }
      await jobs.releaseScheduledAgentRun(
        latestClaim.run.id,
        latestClaim.run.leaseToken,
        "Source unavailable.",
        retryAt
      );
      retryAt = new Date(retryAt.getTime() + 5 * 60_000);
      [latestClaim] = await jobs.claimReadyScheduledAgentRuns({
        leaseForMs: 21_600_000,
        limit: 25,
        now: retryAt,
      });
    }

    expect(await jobs.listScheduledAgentJobs(bob)).toEqual([
      expect.objectContaining({ lastError: "Source unavailable." }),
    ]);

    const [acceptedRun] = await pgliteDatabase
      .insert(schema.scheduledAgentRuns)
      .values({
        attempts: 1,
        jobId: created.id,
        leaseExpiresAt: new Date("2026-09-09T13:05:00.000Z"),
        leaseToken: "00000000-0000-4000-8000-000000000010",
        scheduledFor: new Date("2026-09-09T13:00:00.000Z"),
        startedAt: null,
        status: "running",
        workerSessionId: "accepted-worker-session",
      })
      .returning();
    if (!acceptedRun) throw new Error("Expected an accepted worker run.");
    expect(
      await jobs.claimReadyScheduledAgentRuns({
        leaseForMs: 300_000,
        limit: 25,
        now: new Date("2026-09-09T13:06:00.000Z"),
      })
    ).toEqual([]);

    const [exhaustedRun] = await pgliteDatabase
      .insert(schema.scheduledAgentRuns)
      .values({
        attempts: 3,
        jobId: created.id,
        leaseExpiresAt: new Date("2026-09-09T14:05:00.000Z"),
        leaseToken: "00000000-0000-4000-8000-000000000011",
        scheduledFor: new Date("2026-09-09T14:00:00.000Z"),
        status: "running",
      })
      .returning();
    if (!exhaustedRun) throw new Error("Expected an exhausted worker run.");
    expect(
      await jobs.claimReadyScheduledAgentRuns({
        leaseForMs: 300_000,
        limit: 25,
        now: new Date("2026-09-09T14:06:00.000Z"),
      })
    ).toEqual([]);
    expect(
      await jobs.claimScheduledReport(
        exhaustedRun.id,
        new Date("2026-09-09T14:06:01.000Z")
      )
    ).toMatchObject({
      run: {
        outcome: {
          kind: "blocked",
          summary:
            "The scheduled task could not complete after three attempts.",
        },
        reportStatus: "queued",
        status: "dead_letter",
      },
    });
  }, 20_000);
});

describe("handing an answer to a waiting worker", { timeout: 30_000 }, () => {
  const alice = { userId: "alice", workspaceId: "workspace:alice" };
  const askedAt = new Date("2026-09-01T13:00:00.000Z");
  const answer = [{ requestId: "request-question", text: "LGA" }];

  it("lets a later tick take over a hand-off whose tick died", async () => {
    const { jobs } = await openDatabase();
    const run = await answeredRun(jobs);
    const handOffAt = new Date("2026-09-01T13:05:00.000Z");
    const [claim] = await jobs.claimAnsweredScheduledAgentRuns({
      limit: 25,
      now: handOffAt,
    });
    expect(claim?.run).toMatchObject({ id: run.id, status: "running" });
    // The tick dies before the worker gets the answer. While its short
    // lease holds, nobody else hands the answer over…
    expect(
      await jobs.claimAnsweredScheduledAgentRuns({
        limit: 25,
        now: new Date("2026-09-01T13:09:00.000Z"),
      })
    ).toEqual([]);
    // …and once it lapses, the next tick does.
    const [retaken] = await jobs.claimAnsweredScheduledAgentRuns({
      limit: 25,
      now: new Date("2026-09-01T13:10:00.000Z"),
    });
    expect(retaken?.run).toMatchObject({
      id: run.id,
      inputResponses: answer,
      leaseToken: run.leaseToken,
      status: "running",
    });

    // A worker that took its answer runs on under a worker's lease.
    const tookAt = new Date("2026-09-01T13:10:01.000Z");
    await jobs.finishScheduledAgentRunInput(run.id, run.leaseToken, tookAt);
    expect(
      await jobs.claimAnsweredScheduledAgentRuns({
        limit: 25,
        now: new Date("2026-09-01T15:00:00.000Z"),
      })
    ).toEqual([]);
    const leases = await import("@db/services/scheduled-agent-run-leases");
    expect(
      await leases.isScheduledAgentRunLeaseActive(
        run.id,
        run.leaseToken,
        new Date("2026-09-01T18:00:00.000Z")
      )
    ).toBe(true);
  });

  it("ends a run whose worker is gone and tells the person", async () => {
    const { db, jobs } = await openDatabase();
    const run = await answeredRun(jobs);
    const handOffAt = new Date("2026-09-01T13:05:00.000Z");
    await jobs.claimAnsweredScheduledAgentRuns({ limit: 25, now: handOffAt });

    await jobs.restoreScheduledAgentRunInput(
      run.id,
      run.leaseToken,
      "The scheduled session is no longer active.",
      null,
      handOffAt
    );

    expect(
      await db.query.scheduledAgentRuns.findFirst({
        where: (runs, { eq }) => eq(runs.id, run.id),
      })
    ).toMatchObject({
      inputResponses: null,
      leaseToken: null,
      outcome: { kind: "blocked" },
      pendingInputRequests: null,
      reportStatus: "pending",
      status: "dead_letter",
    });
    // The person can no longer answer into it, and its report goes out.
    expect(await jobs.getScheduledAgentRunInput(alice, run.id)).toBeUndefined();
    expect(await jobs.listRecoverableScheduledReports(handOffAt)).toMatchObject(
      [{ runId: run.id }]
    );
  });

  it("keeps the answer for a worker still starting", async () => {
    const { jobs } = await openDatabase();
    const run = await answeredRun(jobs);
    const handOffAt = new Date("2026-09-01T13:05:00.000Z");
    await jobs.claimAnsweredScheduledAgentRuns({ limit: 25, now: handOffAt });

    await jobs.restoreScheduledAgentRunInput(
      run.id,
      run.leaseToken,
      "The scheduled session is no longer active.",
      { at: new Date("2026-09-01T13:06:00.000Z") },
      handOffAt
    );

    expect(
      await jobs.claimAnsweredScheduledAgentRuns({
        limit: 25,
        now: new Date("2026-09-01T13:06:00.000Z"),
      })
    ).toMatchObject([{ run: { id: run.id, inputResponses: answer } }]);
  });

  /** A run whose worker asked, whose question reached the person, answered. */
  async function answeredRun(
    jobs: Awaited<ReturnType<typeof openDatabase>>["jobs"]
  ) {
    const scope = await import("@db/services/scope");
    await scope.ensureScope(alice);
    await jobs.createScheduledAgentJob(
      alice,
      {
        conversationChannel: "telegram",
        conversationId: "100::",
        missedRunPolicy: "run_latest",
        prompt: "Book the airport transfer.",
        timing: { at: askedAt.toISOString(), kind: "once" },
      },
      new Date("2026-09-01T12:00:00.000Z")
    );
    await jobs.materializeDueScheduledAgentRuns({ limit: 25, now: askedAt });
    const [claim] = await jobs.claimReadyScheduledAgentRuns({
      leaseForMs: 21_600_000,
      limit: 25,
      now: askedAt,
    });
    const leaseToken = claim?.run.leaseToken;
    if (!claim || !leaseToken) throw new Error("Expected one leased run.");
    await jobs.setScheduledRunSession(claim.run.id, leaseToken, "worker");
    await jobs.waitForScheduledAgentRunInput(
      claim.run.id,
      leaseToken,
      [
        {
          action: {
            callId: "call-question",
            input: { prompt: "Which airport?" },
            kind: "tool-call",
            toolName: "ask_question",
          },
          allowFreeform: true,
          kind: "question",
          prompt: "Which airport?",
          requestId: "request-question",
        },
      ],
      askedAt
    );
    const report = await jobs.claimScheduledReport(claim.run.id, askedAt);
    if (!report?.run.reportLeaseToken) throw new Error("Expected a report.");
    await jobs.finalizeScheduledReport(
      claim.run.id,
      report.run.reportLeaseToken,
      "delivered"
    );
    const submitted = await jobs.submitScheduledAgentRunAnswer(
      claim.run.id,
      leaseToken,
      answer,
      new Date("2026-09-01T13:04:00.000Z")
    );
    if (!submitted) throw new Error("Expected the answer to be stored.");
    return { id: claim.run.id, leaseToken };
  }
});

describe("following the person's timezone", { timeout: 30_000 }, () => {
  const alice = { userId: "alice", workspaceId: "workspace:alice" };
  const now = new Date("2026-09-24T09:00:00.000Z");
  // «Каждое 5-е число в 10 утра».
  const rent = {
    conversationChannel: "telegram" as const,
    conversationId: "100::",
    missedRunPolicy: "run_latest" as const,
    prompt: "Напомнить оплатить квартиру.",
    timing: {
      dayOfMonth: 5,
      frequency: "monthly" as const,
      kind: "calendar" as const,
      localTime: "10:00",
      timezone: "Europe/Moscow",
    },
  };

  it("moves the schedules to the zone the profile ends with when two changes race", async () => {
    const { jobs, profiles } = await openDatabase();
    const scope = await import("@db/services/scope");
    await scope.ensureScope(alice);
    const job = await jobs.createScheduledAgentJob(alice, rent, now);

    await Promise.all([
      profiles.patchUserProfile(alice, { timezone: "Asia/Yekaterinburg" }),
      profiles.patchUserProfile(alice, { timezone: "Asia/Novosibirsk" }),
      profiles.patchUserProfile(alice, { firstName: "Алиса" }),
    ]);

    const profile = await profiles.readUserProfile(alice);
    expect(profile.firstName).toBe("Алиса");
    const [listed] = await jobs.listScheduledAgentJobs(alice);
    expect(listed).toMatchObject({
      id: job.id,
      timing: { timezone: profile.timezone },
    });
  });

  it("keeps the old zone when the schedules could not follow", async () => {
    const { db, jobs, profiles } = await openDatabase();
    const scope = await import("@db/services/scope");
    await scope.ensureScope(alice);
    await jobs.createScheduledAgentJob(alice, rent, now);
    // A stored schedule the move cannot read makes it fail midway.
    await db.insert(schema.scheduledAgentJobs).values({
      ...rent,
      createdByUserId: alice.userId,
      nextRunAt: now,
      status: "active",
      timing: { kind: "calendar", timezone: "Europe/Moscow" },
      workspaceId: alice.workspaceId,
    });

    await expect(
      profiles.patchUserProfile(alice, { timezone: "Asia/Yekaterinburg" })
    ).rejects.toBeInstanceOf(ZodError);

    expect((await profiles.readUserProfile(alice)).timezone).toBeNull();
    const stored = await db.query.scheduledAgentJobs.findMany({
      columns: { timing: true },
    });
    expect(
      stored.map(
        ({ timing }) =>
          z.object({ timezone: z.string() }).parse(timing).timezone
      )
    ).toEqual(["Europe/Moscow", "Europe/Moscow"]);
  });
});

let migrated: Promise<Blob> | undefined;

// Each case starts from a clone of one migrated database.
async function openDatabase() {
  migrated ??= (async () => {
    const template = new PGlite();
    const migrations = (
      await readdir(new URL("../migrations", import.meta.url))
    )
      .filter((name) => name.endsWith(".sql"))
      .toSorted();
    for (const migration of migrations) {
      await applyMigration(template, migration);
    }
    const dump = await template.dumpDataDir("none");
    await template.close();
    return dump;
  })();
  const client = new PGlite({ loadDataDir: await migrated });
  databases.push(client);
  const pgliteDatabase = drizzle(client, { schema });
  // Modules are reset between cases, so the services must see this copy.
  const freshDatabase = await import("@db");
  // SAFETY: PGlite implements the query-builder surface exercised by this service while retaining the shared Drizzle schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The focused test swaps only the database driver.
  vi.spyOn(freshDatabase, "db", "get").mockReturnValue(pgliteDatabase as never);
  return {
    db: pgliteDatabase,
    jobs: await import("@db/services/scheduled-agent-jobs"),
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

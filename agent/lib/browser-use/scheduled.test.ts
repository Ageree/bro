/* oxlint-disable eslint/no-await-in-loop -- Migrations and their statements must be applied in order. */
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as DatabaseModule from "@db";
import * as schema from "@db/schema";
import type { ScheduledBrowserResultDelivery } from "./scheduled";

const databaseHolder = vi.hoisted<{
  current: ReturnType<typeof drizzle> | undefined;
}>(() => ({ current: undefined }));

vi.mock("@db", async (importOriginal) => {
  const original = await importOriginal<typeof DatabaseModule>();
  return {
    ...original,
    get db() {
      if (!databaseHolder.current)
        throw new Error("Expected a PGlite database.");
      return databaseHolder.current;
    },
  };
});

type ScheduledAttachSession = NonNullable<
  ScheduledBrowserResultDelivery["attachSession"]
>;
type ScheduledSend = ReturnType<ScheduledAttachSession>["send"];

const databases: PGlite[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  databaseHolder.current = undefined;
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("scheduled browser result bridge", () => {
  it("handles one-shot browser resume races without stranding the worker", async () => {
    const client = new PGlite();
    databases.push(client);
    const migrationDirectory = new URL(
      "../../../db/migrations/",
      import.meta.url
    );
    const migrations = (await readdir(migrationDirectory))
      .filter((filename) => filename.endsWith(".sql"))
      .toSorted();
    for (const migration of migrations) {
      const source = await readFile(
        new URL(migration, migrationDirectory),
        "utf8"
      );
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.exec(statement);
      }
    }

    const pgliteDatabase = drizzle(client, { schema });
    databaseHolder.current = pgliteDatabase;
    const scope = await import("@db/services/scope");
    const jobs = await import("@db/services/scheduled-agent-jobs");
    const {
      assertScheduledBrowserTaskAllowed,
      resumeScheduledRunForBrowserResult,
    } = await import("./scheduled");
    const owner = { userId: "alice", workspaceId: "workspace:alice" };
    await scope.ensureScope(owner);
    const now = new Date("2099-09-20T12:00:00.000Z");
    const job = await jobs.createScheduledAgentJob(
      owner,
      {
        conversationChannel: "telegram",
        conversationId: "telegram:alice",
        missedRunPolicy: "run_latest",
        prompt: "Only report the fare if it drops below $300.",
        timing: {
          at: "2099-09-20T13:00:00.000Z",
          kind: "once",
        },
      },
      now
    );
    const dueAt = new Date("2099-09-20T13:00:00.000Z");
    await jobs.materializeDueScheduledAgentRuns({ limit: 1, now: dueAt });
    const [claim] = await jobs.claimReadyScheduledAgentRuns({
      leaseForMs: 6 * 60 * 60_000,
      limit: 1,
      now: dueAt,
    });
    if (!claim?.run.leaseToken) throw new Error("Expected a scheduled run.");
    await jobs.setScheduledRunSession(
      claim.run.id,
      claim.run.leaseToken,
      "scheduled-worker-session"
    );
    await assertScheduledBrowserTaskAllowed({
      session: {
        auth: {
          current: {
            attributes: {
              scheduledRunId: claim.run.id,
              scheduledRunLeaseToken: claim.run.leaseToken,
            },
            authenticator: "scheduled-worker",
            principalId: owner.userId,
            principalType: "user",
          },
          initiator: null,
        },
        id: "scheduled-worker-session",
      },
    });
    await assertScheduledBrowserTaskAllowed({
      session: {
        auth: { current: null, initiator: null },
        id: "ordinary-session",
      },
    });
    await client.exec(`
      insert into browser_runs (
        id, workspace_id, created_by_user_id, session_id, task, status,
        conversation_channel, conversation_id, root_session_id, scheduled_origin,
        root_run_id, active_run_id
      ) values
        (
          'browser-run-1', 'workspace:alice', 'alice', 'browser-session-1',
          'Check the current fare.', 'done', 'telegram', 'telegram:alice',
          'scheduled-worker-session',
          '{"runId":"${claim.run.id}","leaseToken":"${claim.run.leaseToken}"}'::jsonb,
          'browser-run-1', 'browser-run-1'
        ),
        (
          'browser-run-2', 'workspace:alice', 'alice', 'browser-session-2',
          'Check the alternate fare.', 'running', 'telegram', 'telegram:alice',
          'scheduled-worker-session',
          '{"runId":"${claim.run.id}","leaseToken":"${claim.run.leaseToken}"}'::jsonb,
          'browser-run-2', 'browser-run-2'
        )
    `);
    await pgliteDatabase
      .update(schema.browserRuns)
      .set({
        completedAt: new Date("2099-09-20T13:00:01.500Z"),
        deliveryState: "claimed",
        deliveryToken: "delivery-1",
      })
      .where(eq(schema.browserRuns.id, "browser-run-1"));
    const input = {
      browserRunId: "browser-run-1",
      conversationChannel: "telegram" as const,
      conversationId: "telegram:alice",
      createdByUserId: "alice",
      liveViewUrl: null,
      outcome:
        "Status: blocked\nEvidence: the result could not verify the fare.\nNeeds: account access.",
      rootSessionId: "scheduled-worker-session",
      scheduledOrigin: {
        leaseToken: claim.run.leaseToken,
        runId: claim.run.id,
      },
      task: "Check the current fare.",
      workspaceId: "workspace:alice",
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    expect(
      await resumeScheduledRunForBrowserResult(
        {},
        {
          ...input,
          rootSessionId: "ordinary-interactive-session",
          scheduledOrigin: null,
        }
      )
    ).toBe("not_scheduled");
    expect(fetch).not.toHaveBeenCalled();
    const browserRunJobs = await import("@db/services/browser-runs");
    const admitted = Promise.withResolvers<boolean>();
    const transport = Promise.withResolvers<boolean>();
    const failedSend = vi
      .fn<ScheduledSend>()
      .mockImplementationOnce(async () => {
        admitted.resolve(true);
        await transport.promise;
        throw new Error("inbox unavailable");
      })
      .mockRejectedValue(new Error("inbox unavailable"));
    const failedAttach = vi.fn<ScheduledAttachSession>(() => ({
      send: failedSend,
    }));
    const fastCallback = resumeScheduledRunForBrowserResult(
      { attachSession: failedAttach },
      input
    );
    await admitted.promise;
    expect(
      await pgliteDatabase.query.scheduledAgentRuns.findFirst({
        columns: { pendingBrowserRunIds: true },
        where: eq(schema.scheduledAgentRuns.id, claim.run.id),
      })
    ).toEqual({ pendingBrowserRunIds: ["browser-run-1"] });
    expect(
      await jobs.completeScheduledAgentRun(
        claim.run.id,
        claim.run.leaseToken,
        "receipt-turn",
        {
          kind: "result",
          summary: "The browser run started.",
          urgency: "normal",
        },
        new Date("2099-09-20T13:00:01.625Z")
      )
    ).toEqual({ status: "deferred" });
    expect(
      await jobs.finishScheduledAgentRunBrowserResume(
        claim.run.id,
        claim.run.leaseToken,
        "browser-run-1",
        new Date("2099-09-20T13:00:01.750Z")
      )
    ).toBe(true);
    transport.resolve(true);
    await expect(fastCallback).rejects.toThrow("inbox unavailable");
    expect(
      await browserRunJobs.markBrowserRunDeliveryAmbiguous(
        "browser-run-1",
        "delivery-1"
      )
    ).toBeUndefined();
    expect(
      await pgliteDatabase.query.browserRuns.findFirst({
        columns: { deliveryState: true },
        where: eq(schema.browserRuns.id, "browser-run-1"),
      })
    ).toEqual({ deliveryState: "acked" });
    await pgliteDatabase
      .update(schema.scheduledAgentRuns)
      .set({ workerSessionId: "replacement-worker-session" })
      .where(eq(schema.scheduledAgentRuns.id, claim.run.id));
    const replacementAttach = vi.fn<ScheduledAttachSession>(() => ({
      send: failedSend,
    }));
    await expect(
      resumeScheduledRunForBrowserResult(
        { attachSession: replacementAttach },
        input
      )
    ).rejects.toThrow("inbox unavailable");
    expect(replacementAttach).toHaveBeenCalledWith(
      "replacement-worker-session"
    );
    await pgliteDatabase
      .update(schema.scheduledAgentRuns)
      .set({ workerSessionId: "scheduled-worker-session" })
      .where(eq(schema.scheduledAgentRuns.id, claim.run.id));
    expect(
      await jobs.getScheduledAgentRunForBrowserResult({
        conversationChannel: input.conversationChannel,
        conversationId: input.conversationId,
        createdByUserId: input.createdByUserId,
        rootSessionId: input.rootSessionId,
        scheduledOrigin: input.scheduledOrigin,
        workspaceId: input.workspaceId,
      })
    ).toMatchObject({ active: true });

    await pgliteDatabase
      .update(schema.scheduledAgentRuns)
      .set({ leaseExpiresAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(schema.scheduledAgentRuns.id, claim.run.id));
    await expect(
      assertScheduledBrowserTaskAllowed({
        session: {
          auth: {
            current: {
              attributes: {
                scheduledRunId: claim.run.id,
                scheduledRunLeaseToken: claim.run.leaseToken,
              },
              authenticator: "scheduled-worker",
              principalId: owner.userId,
              principalType: "user",
            },
            initiator: null,
          },
          id: "scheduled-worker-session",
        },
      })
    ).rejects.toThrow("browser work was not started");
    expect(
      await jobs.completeScheduledAgentRun(
        claim.run.id,
        claim.run.leaseToken,
        "expired-turn",
        {
          kind: "result",
          summary: "An expired worker must not report.",
          urgency: "normal",
        },
        new Date("2099-09-20T19:00:01.000Z")
      )
    ).toBeUndefined();
    expect(
      await resumeScheduledRunForBrowserResult(
        { attachSession: failedAttach },
        input
      )
    ).toBe("stale");
    expect(failedSend).toHaveBeenCalledTimes(2);
    await pgliteDatabase
      .update(schema.scheduledAgentRuns)
      .set({
        leaseExpiresAt: new Date("2099-09-20T19:00:00.000Z"),
        leaseToken: "00000000-0000-4000-8000-000000000099",
        workerSessionId: "retried-worker-session",
      })
      .where(eq(schema.scheduledAgentRuns.id, claim.run.id));
    expect(
      await resumeScheduledRunForBrowserResult(
        { attachSession: failedAttach },
        input
      )
    ).toBe("stale");
    expect(failedSend).toHaveBeenCalledTimes(2);
    await pgliteDatabase
      .update(schema.scheduledAgentRuns)
      .set({
        leaseExpiresAt: new Date("2099-09-20T19:00:00.000Z"),
        leaseToken: claim.run.leaseToken,
        workerSessionId: "scheduled-worker-session",
      })
      .where(eq(schema.scheduledAgentRuns.id, claim.run.id));

    await jobs.updateScheduledAgentJob(
      owner,
      {
        conversationChannel: input.conversationChannel,
        conversationId: input.conversationId,
      },
      job.id,
      { status: "paused" }
    );
    expect(
      await resumeScheduledRunForBrowserResult(
        { attachSession: failedAttach },
        input
      )
    ).toBe("stale");
    expect(failedSend).toHaveBeenCalledTimes(2);
    expect(
      await jobs.completeScheduledAgentRun(
        claim.run.id,
        claim.run.leaseToken,
        "obsolete-browser-result-turn",
        {
          kind: "result",
          summary: "This delayed result must not be reported.",
          urgency: "normal",
        }
      )
    ).toBeUndefined();

    await pgliteDatabase
      .update(schema.scheduledAgentJobs)
      .set({ status: "completed" })
      .where(eq(schema.scheduledAgentJobs.id, job.id));
    const send = vi.fn<ScheduledSend>().mockResolvedValue({
      sessionId: input.rootSessionId,
      status: "accepted",
    });
    const attachSession = vi.fn<ScheduledAttachSession>(() => ({ send }));
    expect(
      await resumeScheduledRunForBrowserResult({ attachSession }, input)
    ).toBe("accepted");
    expect(attachSession).toHaveBeenCalledWith("scheduled-worker-session");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toContain(
      "Only report the fare if it drops below $300."
    );
    expect(send.mock.calls[0]?.[0]).toContain(
      "Status: blocked\nEvidence: the result could not verify the fare."
    );
    expect(send.mock.calls[0]?.[0]).not.toContain("A verified browser run");
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      auth: {
        attributes: {
          scheduledBrowserRunId: "browser-run-1",
          scheduledRunId: claim.run.id,
          scheduledRunLeaseToken: claim.run.leaseToken,
        },
        authenticator: "scheduled-worker",
        principalId: "alice",
      },
      turnPolicy: "queue",
    });
    expect(
      await jobs.completeScheduledAgentRun(
        claim.run.id,
        claim.run.leaseToken,
        "receipt-turn",
        {
          kind: "result",
          summary: "The original worker turn is still settling.",
          urgency: "normal",
        }
      )
    ).toEqual({ status: "deferred" });
    expect(
      await jobs.finishScheduledAgentRunBrowserResume(
        claim.run.id,
        claim.run.leaseToken,
        "browser-run-1",
        new Date("2099-09-20T13:00:04.000Z")
      )
    ).toBe(true);

    expect(
      await jobs.completeScheduledAgentRun(
        claim.run.id,
        claim.run.leaseToken,
        "browser-result-turn",
        {
          kind: "nothing_to_report",
          reason: "The first fare remains above the user's threshold.",
        },
        new Date("2099-09-20T13:00:05.000Z")
      )
    ).toEqual({ status: "deferred" });

    await pgliteDatabase
      .update(schema.browserRuns)
      .set({
        completedAt: new Date("2099-09-20T13:00:06.000Z"),
        deliveryState: "claimed",
        deliveryToken: "delivery-2",
        outcome: "The alternate fare is $250.",
        status: "done",
      })
      .where(eq(schema.browserRuns.id, "browser-run-2"));
    const secondInput = {
      ...input,
      browserRunId: "browser-run-2",
      outcome: "Status: complete\nEvidence: the alternate fare is $250.",
      task: "Check the alternate fare.",
    };
    expect(
      await resumeScheduledRunForBrowserResult({ attachSession }, secondInput)
    ).toBe("accepted");
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      await jobs.finishScheduledAgentRunBrowserResume(
        claim.run.id,
        claim.run.leaseToken,
        "browser-run-2",
        new Date("2099-09-20T13:00:07.000Z")
      )
    ).toBe(true);

    const completed = await jobs.completeScheduledAgentRun(
      claim.run.id,
      claim.run.leaseToken,
      "second-browser-result-turn",
      {
        kind: "result",
        summary: "The alternate fare fell to $250.",
        urgency: "normal",
      },
      new Date("2099-09-20T13:00:08.000Z")
    );
    expect(completed).toMatchObject({
      status: "completed",
      run: {
        reportSequence: 1,
        reportStatus: "pending",
        status: "completed",
      },
    });
    expect(
      await jobs.claimScheduledReport(
        claim.run.id,
        new Date("2099-09-20T13:00:09.000Z")
      )
    ).toMatchObject({
      job: { id: job.id, status: "completed" },
      run: { reportStatus: "queued", status: "completed" },
    });
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    await scope.ensureScope(bob);
    const bobJob = await jobs.createScheduledAgentJob(
      bob,
      {
        conversationChannel: "telegram",
        conversationId: "telegram:bob",
        missedRunPolicy: "run_latest",
        prompt: "Try a browser check and report if it cannot start.",
        timing: { at: "2099-09-21T13:00:00.000Z", kind: "once" },
      },
      new Date("2099-09-21T12:00:00.000Z")
    );
    const bobDueAt = new Date("2099-09-21T13:00:00.000Z");
    await jobs.materializeDueScheduledAgentRuns({ limit: 1, now: bobDueAt });
    const [bobClaim] = await jobs.claimReadyScheduledAgentRuns({
      leaseForMs: 6 * 60 * 60_000,
      limit: 1,
      now: bobDueAt,
    });
    if (!bobClaim?.run.leaseToken) throw new Error("Expected a scheduled run.");
    await jobs.setScheduledRunSession(
      bobClaim.run.id,
      bobClaim.run.leaseToken,
      "failed-browser-worker"
    );
    await assertScheduledBrowserTaskAllowed({
      session: {
        auth: {
          current: {
            attributes: {
              scheduledRunId: bobClaim.run.id,
              scheduledRunLeaseToken: bobClaim.run.leaseToken,
            },
            authenticator: "scheduled-worker",
            principalId: bob.userId,
            principalType: "user",
          },
          initiator: null,
        },
        id: "failed-browser-worker",
      },
    });

    const failedBeforeStart = await jobs.completeScheduledAgentRun(
      bobClaim.run.id,
      bobClaim.run.leaseToken,
      "failed-browser-turn",
      {
        kind: "blocked",
        summary: "The browser quota was exhausted before a run started.",
        userActionNeeded: "Try again after the quota resets.",
      },
      new Date("2099-09-21T13:00:01.000Z")
    );
    expect(failedBeforeStart).toMatchObject({
      status: "completed",
      run: { pendingBrowserRunIds: [], reportStatus: "pending" },
    });
    expect(
      await jobs.claimScheduledReport(
        bobClaim.run.id,
        new Date("2099-09-21T13:00:02.000Z")
      )
    ).toMatchObject({
      job: { id: bobJob.id, status: "completed" },
      run: { reportStatus: "queued" },
    });
  }, 30_000);
});

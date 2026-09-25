import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  inputRequestSchema,
  inputResponseSchema,
  type InputRequest,
  type InputResponse,
} from "eve/client";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  computeNextRun,
  computeLatestRun,
  storedScheduleTimingSchema,
  type ScheduleTiming,
} from "@shared/schedules/timing";
import {
  scheduledRunOutcomeSchema,
  type ScheduledRunOutcome,
} from "@shared/schedules/outcome";
import {
  db,
  proactiveSignals,
  scheduledAgentJobs,
  scheduledAgentRuns,
} from "@db";
import { readRememberedConversations, rememberedMessenger } from "./proactive";

const exhaustedRunOutcome = {
  kind: "blocked",
  summary: "The scheduled task could not complete after three attempts.",
  userActionNeeded: "Try the task again or update the schedule.",
} satisfies ScheduledRunOutcome;

const abandonedInputOutcome = {
  kind: "blocked",
  summary:
    "The scheduled task stopped while waiting for the answer: its background session ended before the answer reached it.",
  userActionNeeded: "Ask for the task again.",
} satisfies ScheduledRunOutcome;

export interface CreateScheduledAgentJob {
  readonly conversationChannel: "eve" | "photon" | "telegram";
  readonly conversationId: string;
  readonly missedRunPolicy: "catch_up" | "run_latest";
  readonly prompt: string;
  readonly replyAnchorMessageId?: string;
  readonly timing: ScheduleTiming;
}

export interface UpdateScheduledAgentJob {
  readonly prompt?: string;
  readonly status?: "active" | "deleted" | "paused";
  readonly timing?: ScheduleTiming;
}

/**
 * A person asked for a task, so its failure is theirs to hear about. A
 * proactive check nobody asked for fails quietly: the next one covers it.
 */
function exhaustedReportStatus(
  kind: (typeof scheduledAgentJobs.$inferSelect)["kind"]
) {
  return kind === "proactive" ? ("not_needed" as const) : ("pending" as const);
}

function parseJob<T extends typeof scheduledAgentJobs.$inferSelect>(job: T) {
  return { ...job, timing: storedScheduleTimingSchema.parse(job.timing) };
}

function parseRun<T extends typeof scheduledAgentRuns.$inferSelect>(run: T) {
  return {
    ...run,
    inputResponses: run.inputResponses
      ? inputResponseSchema.array().min(1).parse(run.inputResponses)
      : null,
    pendingInputRequests: run.pendingInputRequests
      ? inputRequestSchema.array().min(1).parse(run.pendingInputRequests)
      : null,
    outcome: run.outcome ? scheduledRunOutcomeSchema.parse(run.outcome) : null,
  };
}

export async function createScheduledAgentJob(
  scope: AccessScope,
  input: CreateScheduledAgentJob,
  now = new Date()
) {
  const nextRunAt = computeNextRun(input.timing, now);
  if (!nextRunAt) throw new Error("That schedule has no future occurrence.");
  const [job] = await db
    .insert(scheduledAgentJobs)
    .values({
      createdAt: now,
      createdByUserId: scope.userId,
      conversationChannel: input.conversationChannel,
      conversationId: input.conversationId,
      missedRunPolicy: input.missedRunPolicy,
      nextRunAt,
      prompt: input.prompt,
      replyAnchorMessageId: input.replyAnchorMessageId,
      status: "active",
      timing: input.timing,
      updatedAt: now,
      workspaceId: scope.workspaceId,
    })
    .returning();
  if (!job) throw new Error("The schedule could not be created.");
  return parseJob(job);
}

/**
 * A schedule belongs to the person, not to the chat it was made in: any of
 * their conversations, in any channel, sees and manages all of them.
 */
function ownedTasks(scope: AccessScope) {
  return and(
    eq(scheduledAgentJobs.workspaceId, scope.workspaceId),
    eq(scheduledAgentJobs.createdByUserId, scope.userId),
    eq(scheduledAgentJobs.kind, "task"),
    sql`${scheduledAgentJobs.status} <> 'deleted'`
  );
}

export async function listScheduledAgentJobs(scope: AccessScope) {
  const jobs = await db.query.scheduledAgentJobs.findMany({
    orderBy: asc(scheduledAgentJobs.nextRunAt),
    where: ownedTasks(scope),
    with: {
      runs: {
        limit: 1,
        orderBy: desc(scheduledAgentRuns.scheduledFor),
      },
    },
  });
  return jobs.map(({ runs, ...job }) => {
    const parsed = parseJob(job);
    parsed.lastError = runs[0]?.lastError ?? parsed.lastError;
    return Object.assign(parsed, {
      latestRun: runs[0] ? parseRun(runs[0]) : null,
    });
  });
}

/** One of the person's schedules, which a change to its timing starts from. */
export async function getScheduledAgentJob(scope: AccessScope, id: string) {
  const job = await db.query.scheduledAgentJobs.findFirst({
    where: and(eq(scheduledAgentJobs.id, id), ownedTasks(scope)),
  });
  return job ? parseJob(job) : undefined;
}

export async function updateScheduledAgentJob(
  scope: AccessScope,
  id: string,
  patch: UpdateScheduledAgentJob,
  now = new Date()
) {
  const current = await db.query.scheduledAgentJobs.findFirst({
    where: and(eq(scheduledAgentJobs.id, id), ownedTasks(scope)),
  });
  if (!current) return undefined;
  const timing =
    patch.timing ?? storedScheduleTimingSchema.parse(current.timing);
  const status = patch.status ?? current.status;
  const shouldRecompute =
    patch.timing !== undefined ||
    (patch.status === "active" && current.status !== "active");
  const nextRunAt =
    status !== "active"
      ? null
      : shouldRecompute
        ? computeNextRun(timing, now)
        : current.nextRunAt;
  if (status === "active" && !nextRunAt) {
    throw new Error("That schedule has no future occurrence.");
  }
  const [job] = await db
    .update(scheduledAgentJobs)
    .set({
      ...patch,
      nextRunAt,
      revision: sql`${scheduledAgentJobs.revision} + 1`,
      timing,
      updatedAt: now,
    })
    .where(eq(scheduledAgentJobs.id, current.id))
    .returning();
  return job ? parseJob(job) : undefined;
}

/**
 * Moves the person's calendar schedules kept in their old timezone to the new
 * one, so «в 10 утра» stays 10:00 where they live now. A schedule set in
 * another zone on purpose («по Нью-Йорку») keeps its zone, and a one-time
 * reminder is an instant that does not move. It runs in the transaction of
 * the profile change (`database`), so the zone and the schedules move
 * together or not at all.
 */
export async function followScheduleTimeZone(
  scope: AccessScope,
  from: string,
  to: string,
  now = new Date(),
  database: Pick<typeof db, "query" | "update"> = db
) {
  if (from === to) return 0;
  const jobs = await database.query.scheduledAgentJobs.findMany({
    where: and(
      ownedTasks(scope),
      sql`${scheduledAgentJobs.timing}->>'kind' = 'calendar'`,
      sql`${scheduledAgentJobs.timing}->>'timezone' = ${from}`
    ),
  });
  const moved = await Promise.all(
    jobs.map(async (job) => {
      const timing = storedScheduleTimingSchema.parse(job.timing);
      if (timing.kind !== "calendar") return false;
      const followed = { ...timing, timezone: to };
      const [updated] = await database
        .update(scheduledAgentJobs)
        .set({
          nextRunAt:
            job.status === "active"
              ? computeNextRun(followed, now)
              : job.nextRunAt,
          revision: sql`${scheduledAgentJobs.revision} + 1`,
          timing: followed,
          updatedAt: now,
        })
        .where(
          and(
            eq(scheduledAgentJobs.id, job.id),
            eq(scheduledAgentJobs.revision, job.revision)
          )
        )
        .returning({ id: scheduledAgentJobs.id });
      return updated !== undefined;
    })
  );
  return moved.filter(Boolean).length;
}

export async function materializeDueScheduledAgentRuns(options: {
  readonly limit: number;
  readonly now: Date;
}) {
  return db.transaction(async (transaction) => {
    const due = await transaction
      .select()
      .from(scheduledAgentJobs)
      .where(
        and(
          eq(scheduledAgentJobs.kind, "task"),
          eq(scheduledAgentJobs.status, "active"),
          lte(scheduledAgentJobs.nextRunAt, options.now)
        )
      )
      .orderBy(asc(scheduledAgentJobs.nextRunAt))
      .limit(options.limit)
      .for("update", { skipLocked: true });
    const createdRunIds = await Promise.all(
      due.map(async (job) => {
        if (!job.nextRunAt) return undefined;
        const timing = storedScheduleTimingSchema.parse(job.timing);
        const scheduledFor =
          job.missedRunPolicy === "catch_up"
            ? job.nextRunAt
            : (computeLatestRun(timing, options.now) ?? job.nextRunAt);
        const next = computeNextRun(timing, scheduledFor);
        const [run] = await transaction
          .insert(scheduledAgentRuns)
          .values({
            createdAt: options.now,
            jobId: job.id,
            scheduledFor,
            updatedAt: options.now,
          })
          .onConflictDoNothing({
            target: [scheduledAgentRuns.jobId, scheduledAgentRuns.scheduledFor],
          })
          .returning({ id: scheduledAgentRuns.id });
        await transaction
          .update(scheduledAgentJobs)
          .set({
            lastRunAt: scheduledFor,
            nextRunAt: next,
            status: next ? "active" : "completed",
            updatedAt: options.now,
          })
          .where(eq(scheduledAgentJobs.id, job.id));
        return run?.id;
      })
    );
    return createdRunIds.filter((id) => id !== undefined);
  });
}

export async function claimReadyScheduledAgentRuns(options: {
  /** Which jobs' runs to claim; each kind has its own dispatcher. */
  readonly kind?: (typeof scheduledAgentJobs.$inferSelect)["kind"];
  readonly leaseForMs: number;
  readonly limit: number;
  readonly now: Date;
}) {
  return db.transaction(async (transaction) => {
    const ready = await transaction
      .select({ job: scheduledAgentJobs, run: scheduledAgentRuns })
      .from(scheduledAgentRuns)
      .innerJoin(
        scheduledAgentJobs,
        eq(scheduledAgentRuns.jobId, scheduledAgentJobs.id)
      )
      .where(
        and(
          eq(scheduledAgentJobs.kind, options.kind ?? "task"),
          or(
            eq(scheduledAgentRuns.status, "queued"),
            and(
              eq(scheduledAgentRuns.status, "running"),
              isNull(scheduledAgentRuns.workerSessionId),
              lte(scheduledAgentRuns.leaseExpiresAt, options.now)
            )
          ),
          or(
            isNull(scheduledAgentRuns.retryAt),
            lte(scheduledAgentRuns.retryAt, options.now)
          )
        )
      )
      .orderBy(asc(scheduledAgentRuns.scheduledFor))
      .limit(options.limit)
      .for("update", { of: scheduledAgentRuns, skipLocked: true });
    if (ready.length === 0) return [];
    const exhausted = ready.filter(({ run }) => run.attempts >= 3);
    if (exhausted.length > 0) {
      await transaction
        .update(scheduledAgentRuns)
        .set({
          lastError: "Scheduled worker dispatch did not complete.",
          leaseExpiresAt: null,
          leaseToken: null,
          outcome: exhaustedRunOutcome,
          reportSequence: sql`${scheduledAgentRuns.reportSequence} + 1`,
          reportStatus: exhaustedReportStatus(options.kind ?? "task"),
          retryAt: null,
          status: "dead_letter",
          updatedAt: options.now,
        })
        .where(
          inArray(
            scheduledAgentRuns.id,
            exhausted.map(({ run }) => run.id)
          )
        );
    }
    const claimable = ready.filter(({ run }) => run.attempts < 3);
    if (claimable.length === 0) return [];
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(options.now.getTime() + options.leaseForMs);
    const ids = claimable.map(({ run }) => run.id);
    await transaction
      .update(scheduledAgentRuns)
      .set({
        attempts: sql`${scheduledAgentRuns.attempts} + 1`,
        deferredCompletionTurnId: null,
        leaseExpiresAt,
        leaseToken,
        retryAt: null,
        startedAt: null,
        status: "running",
        updatedAt: options.now,
      })
      .where(inArray(scheduledAgentRuns.id, ids));
    return claimable.map(({ job, run }) => ({
      job: parseJob(job),
      run: parseRun({
        ...run,
        attempts: run.attempts + 1,
        leaseExpiresAt,
        leaseToken,
        retryAt: null,
        startedAt: null,
        status: "running",
      }),
    }));
  });
}

export async function setScheduledRunSession(
  runId: string,
  leaseToken: string,
  workerSessionId: string
) {
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({ workerSessionId, updatedAt: new Date() })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  if (run) return true;
  const current = await db.query.scheduledAgentRuns.findFirst({
    columns: { workerSessionId: true },
    where: eq(scheduledAgentRuns.id, runId),
  });
  return current?.workerSessionId === workerSessionId;
}

export async function markScheduledAgentRunStarted(
  runId: string,
  leaseToken: string,
  workerSessionId: string,
  leaseForMs: number,
  now = new Date()
) {
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      leaseExpiresAt: new Date(now.getTime() + leaseForMs),
      startedAt: sql`coalesce(${scheduledAgentRuns.startedAt}, ${now})`,
      updatedAt: now,
      workerSessionId,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  return run !== undefined;
}

export async function waitForScheduledAgentRunInput(
  runId: string,
  leaseToken: string,
  pendingInputRequests: readonly InputRequest[],
  now = new Date()
) {
  const parsedRequests = inputRequestSchema
    .array()
    .min(1)
    .parse(pendingInputRequests);
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      inputResponses: null,
      pendingInputRequests: parsedRequests,
      leaseExpiresAt: null,
      reportSequence: sql`${scheduledAgentRuns.reportSequence} + 1`,
      reportStatus: "pending",
      status: "waiting_for_input",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning();
  return run ? parseRun(run) : undefined;
}

export async function deferScheduledAgentRunCompletion(
  runId: string,
  leaseToken: string,
  turnId: string,
  now = new Date()
) {
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      deferredCompletionTurnId: turnId,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  return run !== undefined;
}

/**
 * The question a person's run is waiting on, whichever of their chats they
 * answer from: the report may have reached a different one than the schedule
 * was made in.
 */
export async function getScheduledAgentRunInput(
  scope: AccessScope,
  runId: string
) {
  const pending = await db.query.scheduledAgentRuns.findFirst({
    where: and(
      eq(scheduledAgentRuns.id, runId),
      eq(scheduledAgentRuns.status, "waiting_for_input"),
      eq(scheduledAgentRuns.reportStatus, "delivered")
    ),
    with: { job: true },
  });
  if (
    !pending ||
    pending.job.workspaceId !== scope.workspaceId ||
    pending.job.createdByUserId !== scope.userId ||
    !pending.leaseToken ||
    !pending.pendingInputRequests ||
    !pending.workerSessionId
  ) {
    return undefined;
  }
  return {
    leaseToken: pending.leaseToken,
    pendingInputRequests: parseRun(pending).pendingInputRequests ?? [],
    runId: pending.id,
  };
}

/**
 * Keeps the person's answer on the waiting run. Only a schedule handler holds
 * the worker session that must receive it, so the next `dynamic` tick hands
 * it over (`claimAnsweredScheduledAgentRuns`). A later answer replaces one
 * not yet handed over.
 */
export async function submitScheduledAgentRunAnswer(
  runId: string,
  leaseToken: string,
  inputResponses: readonly InputResponse[],
  now = new Date()
) {
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      inputResponses: inputResponseSchema.array().min(1).parse(inputResponses),
      lastError: null,
      retryAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "waiting_for_input"),
        eq(scheduledAgentRuns.leaseToken, leaseToken),
        isNotNull(scheduledAgentRuns.workerSessionId)
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  return run !== undefined;
}

/** How long a tick holds an answer it is handing to the worker. */
const answerHandOffMs = 5 * 60_000;
/** How long a worker that took its answer may run, as a dispatched one. */
const resumedWorkerLeaseMs = 6 * 60 * 60_000;

/**
 * Leases the answered runs back to `running`, the way the worker holds them,
 * so exactly one tick resumes each worker session. Until the worker takes
 * the answer (`finishScheduledAgentRunInput`) the run keeps it and the lease
 * is short: a tick that died mid hand-off leaves it to a later tick instead
 * of stranding the run as running.
 */
export async function claimAnsweredScheduledAgentRuns(options: {
  readonly limit: number;
  readonly now: Date;
}) {
  return db.transaction(async (transaction) => {
    const answered = await transaction
      .select({ job: scheduledAgentJobs, run: scheduledAgentRuns })
      .from(scheduledAgentRuns)
      .innerJoin(
        scheduledAgentJobs,
        eq(scheduledAgentRuns.jobId, scheduledAgentJobs.id)
      )
      .where(
        and(
          or(
            eq(scheduledAgentRuns.status, "waiting_for_input"),
            and(
              eq(scheduledAgentRuns.status, "running"),
              lte(scheduledAgentRuns.leaseExpiresAt, options.now)
            )
          ),
          isNotNull(scheduledAgentRuns.inputResponses),
          isNotNull(scheduledAgentRuns.pendingInputRequests),
          isNotNull(scheduledAgentRuns.leaseToken),
          isNotNull(scheduledAgentRuns.workerSessionId),
          or(
            isNull(scheduledAgentRuns.retryAt),
            lte(scheduledAgentRuns.retryAt, options.now)
          )
        )
      )
      .orderBy(asc(scheduledAgentRuns.updatedAt))
      .limit(options.limit)
      .for("update", { of: scheduledAgentRuns, skipLocked: true });
    if (answered.length === 0) return [];
    const leaseExpiresAt = new Date(options.now.getTime() + answerHandOffMs);
    await transaction
      .update(scheduledAgentRuns)
      .set({
        leaseExpiresAt,
        retryAt: null,
        status: "running",
        updatedAt: options.now,
      })
      .where(
        inArray(
          scheduledAgentRuns.id,
          answered.map(({ run }) => run.id)
        )
      );
    return answered.map(({ job, run }) => ({
      job: parseJob(job),
      run: parseRun({
        ...run,
        leaseExpiresAt,
        retryAt: null,
        status: "running" as const,
      }),
    }));
  });
}

/**
 * Puts a run whose answer did not reach the worker back to waiting, with the
 * answer, for a later tick (`retry`). A worker session that is gone never
 * takes it and nothing else can resume the run, so without `retry` the run
 * ends as failed and its report tells the person, the way a run out of
 * attempts does; a proactive check nobody asked for ends quietly.
 */
export async function restoreScheduledAgentRunInput(
  runId: string,
  leaseToken: string,
  errorMessage: string,
  retry: { readonly at: Date } | null,
  now = new Date()
) {
  const held = and(
    eq(scheduledAgentRuns.id, runId),
    eq(scheduledAgentRuns.status, "running"),
    eq(scheduledAgentRuns.leaseToken, leaseToken)
  );
  const lastError = errorMessage.slice(0, 2_000);
  if (retry) {
    await db
      .update(scheduledAgentRuns)
      .set({
        deferredCompletionTurnId: null,
        lastError,
        leaseExpiresAt: null,
        retryAt: retry.at,
        status: "waiting_for_input",
        updatedAt: now,
      })
      .where(held);
    return;
  }
  const run = await db.query.scheduledAgentRuns.findFirst({
    columns: { id: true },
    where: held,
    with: { job: { columns: { kind: true } } },
  });
  if (!run) return;
  await db
    .update(scheduledAgentRuns)
    .set({
      completedAt: now,
      deferredCompletionTurnId: null,
      inputResponses: null,
      lastError,
      leaseExpiresAt: null,
      leaseToken: null,
      outcome: abandonedInputOutcome,
      pendingInputRequests: null,
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      reportSequence: sql`${scheduledAgentRuns.reportSequence} + 1`,
      reportStatus: exhaustedReportStatus(run.job.kind),
      retryAt: null,
      status: "dead_letter",
      updatedAt: now,
    })
    .where(held);
}

/**
 * The worker took the answer and runs on under the same lease, now as long
 * as a dispatched worker may run.
 */
export async function finishScheduledAgentRunInput(
  runId: string,
  leaseToken: string,
  now = new Date()
) {
  await db
    .update(scheduledAgentRuns)
    .set({
      deferredCompletionTurnId: null,
      inputResponses: null,
      leaseExpiresAt: new Date(now.getTime() + resumedWorkerLeaseMs),
      pendingInputRequests: null,
      lastError: null,
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      reportStatus: "not_ready",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    );
}

export async function completeScheduledAgentRun(
  runId: string,
  leaseToken: string,
  turnId: string,
  outcome: ScheduledRunOutcome,
  completedAt = new Date()
) {
  const completionCondition =
    outcome.kind === "nothing_to_report"
      ? isNull(scheduledAgentRuns.deferredCompletionTurnId)
      : or(
          isNull(scheduledAgentRuns.deferredCompletionTurnId),
          ne(scheduledAgentRuns.deferredCompletionTurnId, turnId)
        );
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      completedAt,
      deferredCompletionTurnId: null,
      pendingInputRequests: null,
      lastError: null,
      leaseExpiresAt: null,
      leaseToken: null,
      outcome,
      reportSequence:
        outcome.kind === "nothing_to_report"
          ? scheduledAgentRuns.reportSequence
          : sql`${scheduledAgentRuns.reportSequence} + 1`,
      reportStatus:
        outcome.kind === "nothing_to_report" ? "not_needed" : "pending",
      status: "completed",
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken),
        completionCondition
      )
    )
    .returning();
  if (run) return { status: "completed" as const, run: parseRun(run) };
  const deferred = await db.query.scheduledAgentRuns.findFirst({
    columns: { id: true },
    where: and(
      eq(scheduledAgentRuns.id, runId),
      eq(scheduledAgentRuns.status, "running"),
      eq(scheduledAgentRuns.leaseToken, leaseToken),
      outcome.kind === "nothing_to_report"
        ? isNotNull(scheduledAgentRuns.deferredCompletionTurnId)
        : eq(scheduledAgentRuns.deferredCompletionTurnId, turnId)
    ),
  });
  return deferred ? { status: "deferred" as const } : undefined;
}

export async function releaseScheduledAgentRun(
  runId: string,
  leaseToken: string,
  errorMessage: string,
  now = new Date()
) {
  const run = await db.query.scheduledAgentRuns.findFirst({
    where: and(
      eq(scheduledAgentRuns.id, runId),
      eq(scheduledAgentRuns.leaseToken, leaseToken)
    ),
    with: { job: { columns: { kind: true } } },
  });
  if (!run) return undefined;
  const dead = run.attempts >= 3;
  const [released] = await db
    .update(scheduledAgentRuns)
    .set({
      deferredCompletionTurnId: null,
      lastError: errorMessage.slice(0, 2_000),
      leaseExpiresAt: null,
      leaseToken: null,
      outcome: dead ? exhaustedRunOutcome : run.outcome,
      reportSequence: dead
        ? sql`${scheduledAgentRuns.reportSequence} + 1`
        : scheduledAgentRuns.reportSequence,
      reportStatus: dead
        ? exhaustedReportStatus(run.job.kind)
        : run.reportStatus,
      retryAt: dead ? null : new Date(now.getTime() + 5 * 60_000),
      status: dead ? "dead_letter" : "queued",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, run.id),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning({ status: scheduledAgentRuns.status });
  return released?.status;
}

/** How a worker parked on a sign-in is told apart when the watchdog finds it. */
const authorizationParkPrefix = "Worker is waiting for authorization:";

/**
 * A background worker asked for a sign-in: nobody in its session can give
 * one, so the turn would stay parked with the run held as `running` for the
 * rest of its lease. Ending the lease now hands the run to the watchdog on
 * the next tick (`recoverStuckScheduledAgentRuns`).
 */
export async function parkScheduledAgentRunOnAuthorization(
  runId: string,
  leaseToken: string,
  connection: string,
  now = new Date()
) {
  const [run] = await db
    .update(scheduledAgentRuns)
    .set({
      lastError: `${authorizationParkPrefix} ${connection}.`.slice(0, 2_000),
      leaseExpiresAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.status, "running"),
        eq(scheduledAgentRuns.leaseToken, leaseToken)
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  return run !== undefined;
}

/** A proactive run older than this is about news nobody needs any more. */
const staleProactiveRunMs = 2 * 60 * 60_000;
/**
 * How long past its startup lease a dispatched worker that has not begun its
 * turn is still waited for: Vercel Workflow can queue the first turn behind
 * a backlog or a cold start, and a restart would reset a session about to run.
 */
const workerStartupGraceMs = 20 * 60_000;

function stuckRunOutcome(lastError: string | null): ScheduledRunOutcome {
  if (lastError?.startsWith(authorizationParkPrefix)) {
    const connection = lastError
      .slice(authorizationParkPrefix.length)
      .replace(/\.$/u, "")
      .trim();
    return {
      kind: "blocked",
      summary: `The scheduled task stopped twice on a sign-in (${connection}) that a background run cannot give.`,
      userActionNeeded:
        "Reconnect that account in the chat or the workspace; the next run of the schedule will use it.",
    };
  }
  return {
    kind: "blocked",
    summary:
      "The scheduled task got stuck twice without finishing and was stopped.",
    userActionNeeded: "Try the task again or update the schedule.",
  };
}

/**
 * The watchdog for workers that took their run and went quiet: the lease ran
 * out while the session never finished — parked on a sign-in, or lost. Such
 * a run stays `running` for good, and a proactive one would silence every
 * later check (`queueProactiveRun` sees it busy). The first time it goes back
 * to the queue and a fresh worker session takes it; the second time it ends
 * as `dead_letter` with a blocked outcome, reported to the person, or closed
 * quietly for a proactive check. A proactive run that went stale meanwhile
 * is closed at once. A run holding an answer for its worker is the answer
 * hand-off's to retry (`claimAnsweredScheduledAgentRuns`), and one that never
 * got a session is the dispatcher's (`claimReadyScheduledAgentRuns`).
 */
export async function recoverStuckScheduledAgentRuns(options: {
  readonly limit: number;
  readonly now: Date;
}) {
  return db.transaction(async (transaction) => {
    const stuck = await transaction
      .select({
        attempts: scheduledAgentRuns.attempts,
        id: scheduledAgentRuns.id,
        jobKind: scheduledAgentJobs.kind,
        lastError: scheduledAgentRuns.lastError,
        scheduledFor: scheduledAgentRuns.scheduledFor,
      })
      .from(scheduledAgentRuns)
      .innerJoin(
        scheduledAgentJobs,
        eq(scheduledAgentRuns.jobId, scheduledAgentJobs.id)
      )
      .where(
        and(
          eq(scheduledAgentRuns.status, "running"),
          isNotNull(scheduledAgentRuns.workerSessionId),
          isNull(scheduledAgentRuns.inputResponses),
          lte(scheduledAgentRuns.leaseExpiresAt, options.now),
          // A worker handed its session but not yet in its first turn may
          // just be queued behind others: only its startup lease plus a
          // grace makes it stuck, not the five minutes alone.
          or(
            isNotNull(scheduledAgentRuns.startedAt),
            lte(
              scheduledAgentRuns.leaseExpiresAt,
              new Date(options.now.getTime() - workerStartupGraceMs)
            )
          )
        )
      )
      .orderBy(asc(scheduledAgentRuns.leaseExpiresAt))
      .limit(options.limit)
      .for("update", { of: scheduledAgentRuns, skipLocked: true });
    return Promise.all(
      stuck.map(async (run) => {
        const stale =
          run.jobKind === "proactive" &&
          run.scheduledFor.getTime() <
            options.now.getTime() - staleProactiveRunMs;
        const reason = run.lastError?.startsWith(authorizationParkPrefix)
          ? "authorization"
          : "lease_expired";
        const action =
          run.attempts < 2 && !stale
            ? ("requeued" as const)
            : ("closed" as const);
        await transaction
          .update(scheduledAgentRuns)
          .set(
            action === "requeued"
              ? {
                  deferredCompletionTurnId: null,
                  lastError: `The worker got stuck (${reason}); the run went back to the queue.`,
                  leaseExpiresAt: null,
                  leaseToken: null,
                  retryAt: options.now,
                  status: "queued",
                  updatedAt: options.now,
                }
              : {
                  completedAt: options.now,
                  deferredCompletionTurnId: null,
                  leaseExpiresAt: null,
                  leaseToken: null,
                  outcome: stuckRunOutcome(run.lastError),
                  reportSequence: sql`${scheduledAgentRuns.reportSequence} + 1`,
                  reportStatus: exhaustedReportStatus(run.jobKind),
                  retryAt: null,
                  status: "dead_letter",
                  updatedAt: options.now,
                }
          )
          .where(eq(scheduledAgentRuns.id, run.id));
        return {
          action,
          attempts: run.attempts,
          jobKind: run.jobKind,
          reason: stale ? ("stale" as const) : reason,
          runId: run.id,
        };
      })
    );
  });
}

export async function claimScheduledReport(runId: string, now = new Date()) {
  const reportLeaseToken = randomUUID();
  const [claimed] = await db
    .update(scheduledAgentRuns)
    .set({
      reportLeaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
      reportLeaseToken,
      reportStatus: "queued",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        inArray(scheduledAgentRuns.status, [
          "completed",
          "dead_letter",
          "waiting_for_input",
        ]),
        eq(scheduledAgentRuns.reportStatus, "pending")
      )
    )
    .returning();
  if (!claimed) return undefined;
  const claimedWithJob = await db.query.scheduledAgentRuns.findFirst({
    where: eq(scheduledAgentRuns.id, claimed.id),
    with: { job: true },
  });
  if (!claimedWithJob) return undefined;
  const { job, ...run } = claimedWithJob;
  return {
    ...(await reportConversations(job)),
    job: parseJob(job),
    run: parseRun(run),
  };
}

/**
 * Takes the other finished reports of a proactive job into a claimed report,
 * under its lease: the reports held over the night go out as one morning
 * message with the first report of the day. They share the claim's fate —
 * delivered, released or dropped together (`finalizeScheduledReport`,
 * `releaseScheduledReport`, `dropScheduledReport` act on the lease) — so a
 * report turn that fails puts every one of them back rather than losing any.
 * Returns the absorbed runs' outcomes, oldest first.
 */
export async function absorbHeldProactiveReports(
  claim: {
    readonly jobId: string;
    readonly reportLeaseExpiresAt: Date;
    readonly reportLeaseToken: string;
    readonly runId: string;
  },
  now = new Date()
) {
  const absorbed = await db
    .update(scheduledAgentRuns)
    .set({
      reportLeaseExpiresAt: claim.reportLeaseExpiresAt,
      reportLeaseToken: claim.reportLeaseToken,
      reportStatus: "queued",
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.jobId, claim.jobId),
        ne(scheduledAgentRuns.id, claim.runId),
        eq(scheduledAgentRuns.status, "completed"),
        eq(scheduledAgentRuns.reportStatus, "pending")
      )
    )
    .returning({
      id: scheduledAgentRuns.id,
      outcome: scheduledAgentRuns.outcome,
      scheduledFor: scheduledAgentRuns.scheduledFor,
    });
  return absorbed
    .map((run) => ({
      id: run.id,
      outcome: scheduledRunOutcomeSchema.safeParse(run.outcome).data,
      scheduledFor: run.scheduledFor,
    }))
    .toSorted(
      (left, right) =>
        left.scheduledFor.getTime() - right.scheduledFor.getTime()
    );
}

/**
 * Where a report goes, and where it goes instead when that chat has ended. A
 * messenger has pushes, so the report goes to the Telegram or iMessage chat
 * the person last wrote from, whichever chat the schedule was set up in; the
 * latest web chat gets it only when a schedule set up in the web chat belongs
 * to a person with no messenger. A web chat ends (a session lives 30 days, and
 * nobody reopens one after starting another), so the chat the schedule was set
 * up in and then the latest messenger follow as fallbacks. The hidden
 * proactive job already names the preferred chat (`recordProactiveTarget`).
 * The reply anchor points into the schedule's own chat and goes along only
 * when the report lands there.
 */
async function reportConversations(
  job: typeof scheduledAgentJobs.$inferSelect
) {
  const own = {
    conversationChannel: job.conversationChannel,
    conversationId: job.conversationId,
  };
  const remembered = await readRememberedConversations(job.workspaceId);
  const messenger = remembered && rememberedMessenger(remembered);
  const latestWeb =
    own.conversationChannel === "eve" && remembered?.webConversationId
      ? {
          conversationChannel: "eve" as const,
          conversationId: remembered.webConversationId,
        }
      : undefined;
  const primary = messenger ?? latestWeb ?? own;
  const withAnchor = (conversation: typeof own) => ({
    ...conversation,
    replyAnchorMessageId: sameConversation(conversation, own)
      ? job.replyAnchorMessageId
      : null,
  });
  const fallbacks = [own, messenger]
    .filter((conversation) => conversation !== undefined)
    .filter(
      (conversation, index, list) =>
        !sameConversation(conversation, primary) &&
        list.findIndex((other) => sameConversation(other, conversation)) ===
          index
    )
    .map(withAnchor);
  return { delivery: withAnchor(primary), fallbacks };
}

function sameConversation(
  left: Pick<
    typeof scheduledAgentJobs.$inferSelect,
    "conversationChannel" | "conversationId"
  >,
  right: Pick<
    typeof scheduledAgentJobs.$inferSelect,
    "conversationChannel" | "conversationId"
  >
) {
  return (
    left.conversationChannel === right.conversationChannel &&
    left.conversationId === right.conversationId
  );
}

/** A handover the worker marked as unable to wait for the person's morning. */
function isTimeSensitive(outcome: ScheduledRunOutcome | undefined) {
  return outcome?.kind === "result" && outcome.urgency === "time_sensitive";
}

export async function listRecoverableScheduledReports(
  now = new Date(),
  limit = 25
) {
  return db.transaction(async (transaction) => {
    const reports = await transaction
      .select({
        // Whether a proactive run was handed an event: a flight is the one
        // thing Bro's own check may wake the person for (`proactiveReportTiming`).
        carriesEvent: sql<boolean>`EXISTS (SELECT 1 FROM ${proactiveSignals} WHERE ${proactiveSignals.runId} = ${scheduledAgentRuns.id} AND ${proactiveSignals.source} = 'calendar')`,
        conversationChannel: scheduledAgentJobs.conversationChannel,
        createdByUserId: scheduledAgentJobs.createdByUserId,
        jobKind: scheduledAgentJobs.kind,
        run: scheduledAgentRuns,
        workspaceId: scheduledAgentJobs.workspaceId,
      })
      .from(scheduledAgentRuns)
      .innerJoin(
        scheduledAgentJobs,
        eq(scheduledAgentRuns.jobId, scheduledAgentJobs.id)
      )
      .where(
        and(
          inArray(scheduledAgentRuns.status, [
            "completed",
            "dead_letter",
            "waiting_for_input",
          ]),
          or(
            and(
              eq(scheduledAgentRuns.reportStatus, "pending"),
              or(
                isNull(scheduledAgentRuns.retryAt),
                lte(scheduledAgentRuns.retryAt, now)
              )
            ),
            and(
              eq(scheduledAgentRuns.reportStatus, "queued"),
              lte(scheduledAgentRuns.reportLeaseExpiresAt, now)
            )
          )
        )
      )
      .orderBy(asc(scheduledAgentRuns.updatedAt))
      .limit(limit)
      .for("update", { of: scheduledAgentRuns, skipLocked: true });
    const stale = reports
      .map(({ run }) => run)
      .filter((run) => run.reportStatus === "queued");
    if (stale.length > 0) {
      await transaction
        .update(scheduledAgentRuns)
        .set({
          reportLeaseExpiresAt: null,
          reportLeaseToken: null,
          reportStatus: "pending",
          updatedAt: now,
        })
        .where(
          and(
            inArray(
              scheduledAgentRuns.id,
              stale.map((run) => run.id)
            ),
            eq(scheduledAgentRuns.reportStatus, "queued"),
            lte(scheduledAgentRuns.reportLeaseExpiresAt, now)
          )
        );
    }
    return reports.map(
      ({
        carriesEvent,
        conversationChannel,
        createdByUserId,
        jobKind,
        run,
        workspaceId,
      }) => ({
        carriesEvent,
        conversationChannel,
        jobId: run.jobId,
        jobKind,
        runId: run.id,
        scheduledFor: run.scheduledFor,
        scope: { userId: createdByUserId, workspaceId },
        timeSensitive: isTimeSensitive(
          scheduledRunOutcomeSchema.safeParse(run.outcome).data
        ),
      })
    );
  });
}

/**
 * Holds a pending report back until `until`. A finished run no longer needs
 * `retryAt` for itself, so the same column times its report.
 */
export async function deferScheduledReport(
  runId: string,
  until: Date,
  now = new Date()
) {
  await db
    .update(scheduledAgentRuns)
    .set({ retryAt: until, updatedAt: now })
    .where(
      and(
        eq(scheduledAgentRuns.id, runId),
        eq(scheduledAgentRuns.reportStatus, "pending")
      )
    );
}

/**
 * Ends a claimed report that must reach nobody, e.g. after the person turned
 * proactive messages off (`suppressed`), or when the worker handed nothing
 * over (`not_needed`). Unlike a suppressed report, it also closes a run
 * parked on a question, since that question will now never be asked.
 */
export async function dropScheduledReport(
  runId: string,
  reportLeaseToken: string,
  now = new Date(),
  reportStatus: "not_needed" | "suppressed" = "suppressed"
) {
  // Reports absorbed into this one share its lease and its end.
  const dropped = await db
    .update(scheduledAgentRuns)
    .set({
      completedAt: sql`coalesce(${scheduledAgentRuns.completedAt}, ${now})`,
      leaseExpiresAt: null,
      leaseToken: null,
      pendingInputRequests: null,
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      reportStatus,
      status: sql`CASE WHEN ${scheduledAgentRuns.status} = 'waiting_for_input' THEN 'completed' ELSE ${scheduledAgentRuns.status} END`,
      updatedAt: now,
    })
    .where(
      and(
        eq(scheduledAgentRuns.reportLeaseToken, reportLeaseToken),
        eq(scheduledAgentRuns.reportStatus, "queued")
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  return dropped.some((run) => run.id === runId);
}

export async function releaseScheduledReport(
  runId: string,
  leaseToken: string,
  errorMessage: string
) {
  // A failed report turn puts back every report it carried.
  const released = await db
    .update(scheduledAgentRuns)
    .set({
      lastError: errorMessage.slice(0, 2_000),
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      reportStatus: "pending",
      updatedAt: new Date(),
    })
    .where(eq(scheduledAgentRuns.reportLeaseToken, leaseToken))
    .returning({ id: scheduledAgentRuns.id });
  return released.some((run) => run.id === runId);
}

export async function finalizeScheduledReport(
  runId: string,
  leaseToken: string,
  reportStatus: "delivered" | "suppressed"
) {
  const reportableRunStatus =
    reportStatus === "suppressed"
      ? inArray(scheduledAgentRuns.status, ["completed", "dead_letter"])
      : inArray(scheduledAgentRuns.status, [
          "completed",
          "dead_letter",
          "waiting_for_input",
        ]);
  // The reports absorbed into this one went out in the same message.
  const finalized = await db
    .update(scheduledAgentRuns)
    .set({
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      reportStatus,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledAgentRuns.reportLeaseToken, leaseToken),
        eq(scheduledAgentRuns.reportStatus, "queued"),
        reportableRunStatus
      )
    )
    .returning({ id: scheduledAgentRuns.id });
  return finalized.some((run) => run.id === runId);
}

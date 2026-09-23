import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  db,
  proactiveSignals,
  proactiveWatches,
  scheduledAgentJobs,
  scheduledAgentRuns,
  userProfiles,
} from "@db";
import { ensureScope } from "./scope";

export type ProactiveSignal = Pick<
  typeof proactiveSignals.$inferInsert,
  "dedupeKey" | "itemId" | "source" | "threadId"
>;
type ProactiveConversation = Pick<
  typeof scheduledAgentJobs.$inferInsert,
  "conversationChannel" | "conversationId"
>;

/** The hidden job's prompt; a report turn reads it as the original task. */
const proactiveJobPrompt =
  "Проверить новую почту и события календаря на ближайшие сутки и написать человеку первым, только если есть что-то, требующее действия.";

/**
 * Remembers the conversation Bro may write first to: the latest one the
 * person talked from. A first call creates the hidden `proactive` job and the
 * watch, starting the mail watermark now so old mail is never replayed.
 */
export async function recordProactiveTarget(
  scope: AccessScope,
  conversation: ProactiveConversation,
  now = new Date()
) {
  const [current] = await db
    .select({
      conversationChannel: scheduledAgentJobs.conversationChannel,
      conversationId: scheduledAgentJobs.conversationId,
      jobId: proactiveWatches.jobId,
    })
    .from(proactiveWatches)
    .innerJoin(
      scheduledAgentJobs,
      eq(proactiveWatches.jobId, scheduledAgentJobs.id)
    )
    .where(eq(proactiveWatches.workspaceId, scope.workspaceId))
    .limit(1);
  if (
    current?.conversationChannel === conversation.conversationChannel &&
    current.conversationId === conversation.conversationId
  ) {
    return "unchanged" as const;
  }
  if (current) {
    await db
      .update(scheduledAgentJobs)
      .set({ ...conversation, updatedAt: now })
      .where(eq(scheduledAgentJobs.id, current.jobId));
    return "moved" as const;
  }
  await ensureScope(scope);
  return db.transaction(async (transaction) => {
    const [job] = await transaction
      .insert(scheduledAgentJobs)
      .values({
        ...conversation,
        createdAt: now,
        createdByUserId: scope.userId,
        kind: "proactive",
        missedRunPolicy: "skip",
        nextRunAt: null,
        prompt: proactiveJobPrompt,
        status: "active",
        timing: {
          anchoredAt: now.toISOString(),
          everyMinutes: 15,
          kind: "interval",
        },
        updatedAt: now,
        workspaceId: scope.workspaceId,
      })
      .returning({ id: scheduledAgentJobs.id });
    if (!job) throw new Error("The proactive job could not be created.");
    const [watch] = await transaction
      .insert(proactiveWatches)
      .values({
        createdAt: now,
        createdByUserId: scope.userId,
        jobId: job.id,
        mailCheckedAt: now,
        nextCheckAt: now,
        updatedAt: now,
        workspaceId: scope.workspaceId,
      })
      .onConflictDoNothing({ target: proactiveWatches.workspaceId })
      .returning({ workspaceId: proactiveWatches.workspaceId });
    if (!watch) {
      // A concurrent turn created the watch first; its job is the one in use.
      await transaction
        .delete(scheduledAgentJobs)
        .where(eq(scheduledAgentJobs.id, job.id));
      return "unchanged" as const;
    }
    return "created" as const;
  });
}

/**
 * Leases the watches due for a check. The lease is the next check time
 * itself, so a crashed tick simply retries after `leaseForMs`. Workspaces
 * that opted out are never claimed.
 */
export async function claimDueProactiveWatches(options: {
  readonly leaseForMs: number;
  readonly limit: number;
  readonly now: Date;
}) {
  return db.transaction(async (transaction) => {
    const due = await transaction
      .select({
        createdByUserId: proactiveWatches.createdByUserId,
        googleState: proactiveWatches.googleState,
        jobId: proactiveWatches.jobId,
        mailCheckedAt: proactiveWatches.mailCheckedAt,
        timezone: userProfiles.timezone,
        workspaceId: proactiveWatches.workspaceId,
      })
      .from(proactiveWatches)
      .innerJoin(
        scheduledAgentJobs,
        eq(proactiveWatches.jobId, scheduledAgentJobs.id)
      )
      .leftJoin(
        userProfiles,
        eq(userProfiles.workspaceId, proactiveWatches.workspaceId)
      )
      .where(
        and(
          lte(proactiveWatches.nextCheckAt, options.now),
          eq(scheduledAgentJobs.status, "active"),
          sql`coalesce(${userProfiles.proactiveMessages}, true)`
        )
      )
      .orderBy(proactiveWatches.nextCheckAt)
      .limit(options.limit)
      .for("update", { of: proactiveWatches, skipLocked: true });
    if (due.length === 0) return [];
    await transaction
      .update(proactiveWatches)
      .set({
        nextCheckAt: new Date(options.now.getTime() + options.leaseForMs),
        updatedAt: options.now,
      })
      .where(
        inArray(
          proactiveWatches.workspaceId,
          due.map((watch) => watch.workspaceId)
        )
      );
    return due;
  });
}

/** Pushes the next check out, e.g. past quiet hours or a missing grant. */
export async function deferProactiveWatch(
  workspaceId: string,
  nextCheckAt: Date,
  googleState?: (typeof proactiveWatches.$inferSelect)["googleState"]
) {
  await db
    .update(proactiveWatches)
    // Drizzle leaves a column out of the update when its value is undefined.
    .set({ googleState, nextCheckAt, updatedAt: new Date() })
    .where(eq(proactiveWatches.workspaceId, workspaceId));
}

/** Moves the mail watermark when a check found nothing new to hand over. */
export async function advanceProactiveWatermark(
  workspaceId: string,
  mailCheckedAt: Date
) {
  await db
    .update(proactiveWatches)
    .set({ googleState: "connected", mailCheckedAt, updatedAt: mailCheckedAt })
    .where(eq(proactiveWatches.workspaceId, workspaceId));
}

/** The candidates no earlier proactive run has been handed. */
export async function filterUnseenProactiveSignals<
  T extends Pick<ProactiveSignal, "dedupeKey" | "source">,
>(workspaceId: string, candidates: readonly T[]) {
  if (candidates.length === 0) return [];
  const seen = await db
    .select({
      dedupeKey: proactiveSignals.dedupeKey,
      source: proactiveSignals.source,
    })
    .from(proactiveSignals)
    .where(
      and(
        eq(proactiveSignals.workspaceId, workspaceId),
        inArray(
          proactiveSignals.dedupeKey,
          candidates.map((candidate) => candidate.dedupeKey)
        )
      )
    );
  const seenKeys = new Set(seen.map((row) => `${row.source}:${row.dedupeKey}`));
  return candidates.filter(
    (candidate) => !seenKeys.has(`${candidate.source}:${candidate.dedupeKey}`)
  );
}

/**
 * Queues one proactive run carrying the new signals and moves the watermark,
 * all at once. While an earlier run is still open nothing is queued and the
 * watermark stays, so the next check hands the same signals over instead of
 * starting a second message in parallel.
 */
export async function queueProactiveRun(input: {
  readonly jobId: string;
  readonly mailCheckedAt: Date;
  readonly now: Date;
  readonly signals: readonly ProactiveSignal[];
  readonly workspaceId: string;
}) {
  return db.transaction(async (transaction) => {
    const [open] = await transaction
      .select({ id: scheduledAgentRuns.id })
      .from(scheduledAgentRuns)
      .where(
        and(
          eq(scheduledAgentRuns.jobId, input.jobId),
          // A run parked on a question is left out: an unanswered question
          // must not silence every later check.
          inArray(scheduledAgentRuns.status, ["queued", "running"])
        )
      )
      .limit(1);
    if (open) return undefined;
    const [run] = await transaction
      .insert(scheduledAgentRuns)
      .values({
        createdAt: input.now,
        jobId: input.jobId,
        scheduledFor: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({
        target: [scheduledAgentRuns.jobId, scheduledAgentRuns.scheduledFor],
      })
      .returning({ id: scheduledAgentRuns.id });
    if (!run) return undefined;
    await transaction
      .insert(proactiveSignals)
      .values(
        input.signals.map((signal) => ({
          ...signal,
          createdAt: input.now,
          runId: run.id,
          workspaceId: input.workspaceId,
        }))
      )
      .onConflictDoNothing();
    await transaction
      .update(proactiveWatches)
      .set({
        googleState: "connected",
        mailCheckedAt: input.mailCheckedAt,
        updatedAt: input.now,
      })
      .where(eq(proactiveWatches.workspaceId, input.workspaceId));
    await transaction
      .update(scheduledAgentJobs)
      .set({ lastRunAt: input.now, updatedAt: input.now })
      .where(eq(scheduledAgentJobs.id, input.jobId));
    return run.id;
  });
}

/** The signals one proactive run was handed, for its worker prompt. */
export async function listProactiveRunSignals(runId: string) {
  return db
    .select({
      itemId: proactiveSignals.itemId,
      source: proactiveSignals.source,
      threadId: proactiveSignals.threadId,
    })
    .from(proactiveSignals)
    .where(eq(proactiveSignals.runId, runId))
    .orderBy(proactiveSignals.source, proactiveSignals.createdAt);
}

/**
 * Forgets dedupe keys older than anything a check can still see: mail is
 * searched at most a day back and events a little over a day ahead.
 */
export async function pruneProactiveSignals(before: Date) {
  await db
    .delete(proactiveSignals)
    .where(lt(proactiveSignals.createdAt, before));
}

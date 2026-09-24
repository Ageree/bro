import { and, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
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
type RememberedConversations = Pick<
  typeof proactiveWatches.$inferSelect,
  "messengerChannel" | "messengerConversationId" | "webConversationId"
>;

/** The hidden job's prompt; a report turn reads it as the original task. */
const proactiveJobPrompt =
  "Проверить новую почту и события календаря на ближайшие сутки и написать человеку первым, только если есть что-то, требующее действия.";

const rememberedColumns = {
  messengerChannel: proactiveWatches.messengerChannel,
  messengerConversationId: proactiveWatches.messengerConversationId,
  webConversationId: proactiveWatches.webConversationId,
};

/** What the watch remembers once the person wrote from `conversation`. */
function remember(
  current: RememberedConversations,
  conversation: ProactiveConversation
): RememberedConversations {
  return conversation.conversationChannel === "eve"
    ? { ...current, webConversationId: conversation.conversationId }
    : {
        ...current,
        messengerChannel: conversation.conversationChannel,
        messengerConversationId: conversation.conversationId,
      };
}

/** The Telegram or iMessage chat the person last wrote from, if any. */
export function rememberedMessenger(remembered: RememberedConversations) {
  return remembered.messengerChannel && remembered.messengerConversationId
    ? {
        conversationChannel: remembered.messengerChannel,
        conversationId: remembered.messengerConversationId,
      }
    : undefined;
}

/**
 * Where Bro writes first: the messenger the person last wrote from, since it
 * has pushes and the web chat shows only what is on screen when someone opens
 * it. The web chat is the target only for a person with no messenger at all.
 */
function preferredConversation(
  remembered: RememberedConversations,
  fallback: ProactiveConversation
): ProactiveConversation {
  const messenger = rememberedMessenger(remembered);
  if (messenger) return messenger;
  return remembered.webConversationId
    ? {
        conversationChannel: "eve",
        conversationId: remembered.webConversationId,
      }
    : fallback;
}

function sameConversation(
  left: ProactiveConversation,
  right: ProactiveConversation
) {
  return (
    left.conversationChannel === right.conversationChannel &&
    left.conversationId === right.conversationId
  );
}

function sameRemembered(
  left: RememberedConversations,
  right: RememberedConversations
) {
  return (
    left.messengerChannel === right.messengerChannel &&
    left.messengerConversationId === right.messengerConversationId &&
    left.webConversationId === right.webConversationId
  );
}

/** The chats a workspace's person last wrote from, when they ever did. */
export async function readRememberedConversations(workspaceId: string) {
  const [remembered] = await db
    .select(rememberedColumns)
    .from(proactiveWatches)
    .where(eq(proactiveWatches.workspaceId, workspaceId))
    .limit(1);
  return remembered;
}

function readWatchTarget(
  executor: Pick<typeof db, "select">,
  workspaceId: string
) {
  return executor
    .select({
      ...rememberedColumns,
      conversationChannel: scheduledAgentJobs.conversationChannel,
      conversationId: scheduledAgentJobs.conversationId,
      jobId: proactiveWatches.jobId,
    })
    .from(proactiveWatches)
    .innerJoin(
      scheduledAgentJobs,
      eq(proactiveWatches.jobId, scheduledAgentJobs.id)
    )
    .where(eq(proactiveWatches.workspaceId, workspaceId))
    .limit(1);
}

/**
 * Remembers the chat the person talks from: the latest messenger and the
 * latest web chat, each on its own. The hidden job writes to the preferred
 * one (`preferredConversation`), so a person who lives in Telegram and once
 * opened the web chat keeps getting reminders with a push. A first call
 * creates the hidden `proactive` job and the watch, starting the mail
 * watermark now so old mail is never replayed.
 */
export async function recordProactiveTarget(
  scope: AccessScope,
  conversation: ProactiveConversation,
  now = new Date()
): Promise<"created" | "moved" | "remembered" | "unchanged"> {
  const [current] = await readWatchTarget(db, scope.workspaceId);
  if (current) {
    const remembered = remember(current, conversation);
    if (
      sameRemembered(remembered, current) &&
      sameConversation(preferredConversation(remembered, current), current)
    ) {
      return "unchanged" as const;
    }
    return db.transaction(async (transaction) => {
      // Two chats may write at once; each builds on what the other left.
      const [locked] = await readWatchTarget(
        transaction,
        scope.workspaceId
      ).for("update", { of: proactiveWatches });
      if (!locked) return "unchanged" as const;
      const next = remember(locked, conversation);
      const target = preferredConversation(next, locked);
      await transaction
        .update(proactiveWatches)
        .set({ ...next, updatedAt: now })
        .where(eq(proactiveWatches.workspaceId, scope.workspaceId));
      if (sameConversation(target, locked)) return "remembered" as const;
      await transaction
        .update(scheduledAgentJobs)
        .set({ ...target, updatedAt: now })
        .where(eq(scheduledAgentJobs.id, locked.jobId));
      return "moved" as const;
    });
  }
  await ensureScope(scope);
  const created = await db.transaction(async (transaction) => {
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
        ...remember(
          {
            messengerChannel: null,
            messengerConversationId: null,
            webConversationId: null,
          },
          conversation
        ),
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
      return "raced" as const;
    }
    return "created" as const;
  });
  // This chat is still remembered on the watch the other turn created.
  return created === "raced"
    ? recordProactiveTarget(scope, conversation, now)
    : created;
}

/**
 * Leases the watches due for a check. The lease is the next check time
 * itself, so a crashed tick simply retries after `leaseForMs`; each claim
 * carries it as `leaseUntil`, which the check's own deferral must still find
 * (`deferProactiveWatch`). Workspaces that opted out are never claimed.
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
    const leaseUntil = new Date(options.now.getTime() + options.leaseForMs);
    await transaction
      .update(proactiveWatches)
      .set({ nextCheckAt: leaseUntil, updatedAt: options.now })
      .where(
        inArray(
          proactiveWatches.workspaceId,
          due.map((watch) => watch.workspaceId)
        )
      );
    return due.map((watch) => ({ ...watch, leaseUntil }));
  });
}

type ClaimedProactiveWatch = Awaited<
  ReturnType<typeof claimDueProactiveWatches>
>[number];

/**
 * Pushes the next check out, e.g. past quiet hours or a missing grant. It
 * lands only while the claim is untouched: a Google connection completed
 * during the check woke the watch (`wakeProactiveWatch`), and the check's
 * «no grant, look again in six hours» would otherwise bury it. Returns
 * whether the deferral landed.
 */
export async function deferProactiveWatch(
  claim: Pick<
    ClaimedProactiveWatch,
    "googleState" | "leaseUntil" | "workspaceId"
  >,
  nextCheckAt: Date,
  googleState?: ClaimedProactiveWatch["googleState"]
) {
  const deferred = await db
    .update(proactiveWatches)
    // Drizzle leaves a column out of the update when its value is undefined.
    .set({ googleState, nextCheckAt, updatedAt: new Date() })
    .where(
      and(
        eq(proactiveWatches.workspaceId, claim.workspaceId),
        eq(proactiveWatches.nextCheckAt, claim.leaseUntil),
        eq(proactiveWatches.googleState, claim.googleState)
      )
    )
    .returning({ workspaceId: proactiveWatches.workspaceId });
  return deferred.length > 0;
}

/**
 * Brings the next check forward once Google is connected again, from the
 * cabinet or from the chat. A check that found no grant waits hours before
 * looking again, so a person who connects right after it would otherwise
 * hear nothing until then. A watch without a working grant (`disconnected`,
 * or `unknown` before its first check) is due now, which also voids the
 * lease of a check in flight, so that check's deferral misses. A connected
 * watch keeps its cadence and only forgets its state, which voids a deferral
 * all the same. Returns whether the next check moved forward.
 */
export async function wakeProactiveWatch(
  scope: Pick<AccessScope, "workspaceId">,
  now = new Date()
) {
  const woken = await db
    .update(proactiveWatches)
    .set({
      googleState: "unknown",
      nextCheckAt: sql`CASE WHEN ${proactiveWatches.googleState} = 'connected' THEN ${proactiveWatches.nextCheckAt} ELSE ${now.toISOString()}::timestamptz END`,
      updatedAt: now,
    })
    .where(eq(proactiveWatches.workspaceId, scope.workspaceId))
    .returning({ nextCheckAt: proactiveWatches.nextCheckAt });
  return woken.some((watch) => watch.nextCheckAt.getTime() === now.getTime());
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
 * all at once. Nothing is queued, and the watermark stays so the next check
 * hands the same signals over, while an earlier run is still open (no second
 * message in parallel) or once the workspace had `maxRunsPerDay` runs in the
 * last 24 hours (a busy inbox never turns into a model run per check). A run
 * carrying a calendar event passes the cap: events are few, and one that
 * waited for the cap to reset could start before anyone heard of it.
 */
export async function queueProactiveRun(input: {
  readonly jobId: string;
  readonly mailCheckedAt: Date;
  readonly maxRunsPerDay: number;
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
    if (open) return { status: "busy" as const };
    const [recent] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(scheduledAgentRuns)
      .where(
        and(
          eq(scheduledAgentRuns.jobId, input.jobId),
          gt(
            scheduledAgentRuns.scheduledFor,
            new Date(input.now.getTime() - 24 * 60 * 60_000)
          )
        )
      );
    const carriesEvent = input.signals.some(
      (signal) => signal.source === "calendar"
    );
    if (!carriesEvent && (recent?.count ?? 0) >= input.maxRunsPerDay) {
      return { status: "capped" as const };
    }
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
    if (!run) return { status: "busy" as const };
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
    return { runId: run.id, status: "queued" as const };
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

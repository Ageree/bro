import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import type { ScheduledRunOutcome } from "@shared/schedules/outcome";
import type { FlightSource, FlightState } from "@shared/subscriptions/flight";
import type {
  PriceCondition,
  PriceSource,
  PriceState,
} from "@shared/subscriptions/price";
import { db, scheduledAgentJobs, scheduledAgentRuns, subscriptions } from "@db";

/** The statuses of a watch still checked, or able to be resumed. */
const liveStatuses = ["active", "paused"] as const;

/**
 * The watches the person set up and manages (`watch-create`): their own
 * hidden job carries the reports. A flight's watch is Bro's own, on the
 * proactive job, and is neither listed nor changed by the person's tools.
 */
const personTemplate = "price";

/** Failed checks in a row after which a watch stops and the person hears. */
export const maximumSubscriptionFailures = 3;

export interface NewSubscription {
  readonly checkEverySeconds: number;
  readonly condition: PriceCondition;
  readonly conversation: {
    readonly conversationChannel: "eve" | "photon" | "telegram";
    readonly conversationId: string;
  };
  /** How the watch reads in the person's list of schedules. */
  readonly description: string;
  readonly dedupeKey: string;
  readonly expiresAt: Date;
  readonly replyAnchorMessageId?: string;
  readonly source: PriceSource;
  readonly state: PriceState;
  readonly template: typeof personTemplate;
}

/**
 * Sets up a watch with the hidden job its hits are reported through. A live
 * watch of the same thing (`dedupeKey`) takes the new condition and term
 * instead of a second watch starting beside it: «ниже 7 000» after «ниже
 * 8 000» moves the threshold. The first check is one period away: the
 * caller has just read the page.
 */
export async function createSubscription(
  scope: AccessScope,
  input: NewSubscription,
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    // Two turns setting up the same page at once take turns here: the row
    // lock below finds nothing to lock while neither has inserted yet.
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`subscription:${scope.workspaceId}:${scope.userId}:${input.template}:${input.dedupeKey}`}, 0))`
    );
    const [existing] = await transaction
      .select({ id: subscriptions.id, jobId: subscriptions.jobId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, scope.workspaceId),
          eq(subscriptions.createdByUserId, scope.userId),
          eq(subscriptions.template, input.template),
          eq(subscriptions.dedupeKey, input.dedupeKey),
          inArray(subscriptions.status, [...liveStatuses])
        )
      )
      .for("update");
    const nextCheckAt = new Date(
      now.getTime() + input.checkEverySeconds * 1_000
    );
    if (existing) {
      const [updated] = await transaction
        .update(subscriptions)
        .set({
          checkEverySeconds: input.checkEverySeconds,
          condition: input.condition,
          createdAt: now,
          expiresAt: input.expiresAt,
          failures: 0,
          lastError: null,
          nextCheckAt,
          source: input.source,
          state: input.state,
          status: "active",
          updatedAt: now,
        })
        .where(eq(subscriptions.id, existing.id))
        .returning();
      // The news goes where the person asked last, in reply to that ask.
      await transaction
        .update(scheduledAgentJobs)
        .set({
          conversationChannel: input.conversation.conversationChannel,
          conversationId: input.conversation.conversationId,
          prompt: input.description,
          replyAnchorMessageId: input.replyAnchorMessageId ?? null,
          status: "active",
          updatedAt: now,
        })
        .where(eq(scheduledAgentJobs.id, existing.jobId));
      if (!updated) throw new Error("The watch could not be updated.");
      return { created: false, subscription: updated };
    }
    const [job] = await transaction
      .insert(scheduledAgentJobs)
      .values({
        conversationChannel: input.conversation.conversationChannel,
        conversationId: input.conversation.conversationId,
        createdAt: now,
        createdByUserId: scope.userId,
        kind: "subscription",
        missedRunPolicy: "skip",
        nextRunAt: null,
        prompt: input.description,
        replyAnchorMessageId: input.replyAnchorMessageId,
        status: "active",
        timing: { at: input.expiresAt.toISOString(), kind: "once" },
        updatedAt: now,
        workspaceId: scope.workspaceId,
      })
      .returning({ id: scheduledAgentJobs.id });
    if (!job) throw new Error("The watch could not be created.");
    const [subscription] = await transaction
      .insert(subscriptions)
      .values({
        checkEverySeconds: input.checkEverySeconds,
        condition: input.condition,
        createdAt: now,
        createdByUserId: scope.userId,
        dedupeKey: input.dedupeKey,
        expiresAt: input.expiresAt,
        jobId: job.id,
        nextCheckAt,
        source: input.source,
        state: input.state,
        template: input.template,
        updatedAt: now,
        workspaceId: scope.workspaceId,
      })
      .returning();
    if (!subscription) throw new Error("The watch could not be created.");
    return { created: true, subscription };
  });
}

/**
 * Leases the watches due for a check. The lease is the next check time
 * itself, so a crashed tick retries after `leaseForMs`; each claim carries it
 * as `leaseUntil`, which the check's own result must still find
 * (`settleSubscriptionCheck`). A paused watch whose term ran out ends here
 * quietly: the person paused it, so no news of it is owed.
 */
export async function claimDueSubscriptions(options: {
  readonly leaseForMs: number;
  readonly limit: number;
  readonly now: Date;
}) {
  return db.transaction(async (transaction) => {
    const lapsed = await transaction
      .update(subscriptions)
      .set({ status: "expired", updatedAt: options.now })
      .where(
        and(
          eq(subscriptions.template, personTemplate),
          eq(subscriptions.status, "paused"),
          lte(subscriptions.expiresAt, options.now)
        )
      )
      .returning({ jobId: subscriptions.jobId });
    if (lapsed.length > 0) {
      await transaction
        .update(scheduledAgentJobs)
        .set({ status: "completed", updatedAt: options.now })
        .where(
          inArray(
            scheduledAgentJobs.id,
            lapsed.map((watch) => watch.jobId)
          )
        );
    }
    const due = await transaction
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.status, "active"),
          lte(subscriptions.nextCheckAt, options.now)
        )
      )
      .orderBy(asc(subscriptions.nextCheckAt))
      .limit(options.limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const leaseUntil = new Date(options.now.getTime() + options.leaseForMs);
    await transaction
      .update(subscriptions)
      .set({ nextCheckAt: leaseUntil, updatedAt: options.now })
      .where(
        inArray(
          subscriptions.id,
          due.map((subscription) => subscription.id)
        )
      );
    return due.map((subscription) =>
      Object.assign(subscription, { leaseUntil })
    );
  });
}

export type ClaimedSubscription = Awaited<
  ReturnType<typeof claimDueSubscriptions>
>[number];

/**
 * What one check found:
 * - `quiet`: a reading, nothing to tell; the next check is a period away.
 * - `failed`: no reading. The next check backs off; the third failure in a
 *   row ends the watch with `outcome`, so the person hears once.
 * - `hit`: news for the person (`outcome`); the watch has done its job.
 * - `expired`: the term ran out; `outcome` tells the person.
 * - `held`: not checked now (the workspace left the pilot); the next check
 *   is at `nextCheckAt`, and nothing else changes.
 * - `lapsed`: the term ran out while held; it ends without a word.
 */
export type SubscriptionCheck =
  | {
      readonly kind: "expired" | "hit";
      readonly outcome: ScheduledRunOutcome;
      readonly state?: PriceState;
    }
  | {
      readonly kind: "failed";
      readonly error: string;
      readonly nextCheckAt: Date;
      readonly outcome: ScheduledRunOutcome;
    }
  | {
      readonly kind: "quiet";
      readonly nextCheckAt: Date;
      readonly state: PriceState;
    }
  | { readonly kind: "held"; readonly nextCheckAt: Date }
  | { readonly kind: "lapsed" };

/**
 * Writes a check's result. It lands only while the claim's lease is still
 * the watch's: a watch paused or deleted during the check keeps that, and a
 * tick that lost the lease writes nothing. A result for the person is a run
 * of the watch's job written already finished, with its report pending: the
 * schedule tick (`agent/schedules/dynamic.ts`) delivers it like any other.
 * Returns what the check ended in, or undefined when it lost the lease.
 */
export async function settleSubscriptionCheck(
  claim: Pick<ClaimedSubscription, "id" | "jobId" | "leaseUntil">,
  check: SubscriptionCheck,
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    const [current] = await transaction
      .select({
        failures: subscriptions.failures,
        template: subscriptions.template,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.id, claim.id),
          eq(subscriptions.status, "active"),
          eq(subscriptions.nextCheckAt, claim.leaseUntil)
        )
      )
      .for("update");
    if (!current) return undefined;
    if (check.kind === "held") {
      await transaction
        .update(subscriptions)
        .set({ nextCheckAt: check.nextCheckAt, updatedAt: now })
        .where(eq(subscriptions.id, claim.id));
      return "held" as const;
    }
    if (check.kind === "lapsed") {
      await transaction
        .update(subscriptions)
        .set({ status: "expired", updatedAt: now })
        .where(eq(subscriptions.id, claim.id));
      // A flight's job is the proactive one, which goes on.
      if (current.template === personTemplate) {
        await transaction
          .update(scheduledAgentJobs)
          .set({ status: "completed", updatedAt: now })
          .where(eq(scheduledAgentJobs.id, claim.jobId));
      }
      return "lapsed" as const;
    }
    // Only a person's watch reports through its own job.
    if (current.template !== personTemplate) return undefined;
    const counted = {
      checks: sql`${subscriptions.checks} + 1`,
      lastCheckedAt: now,
      updatedAt: now,
    };
    if (check.kind === "quiet") {
      await transaction
        .update(subscriptions)
        .set({
          ...counted,
          failures: 0,
          lastError: null,
          nextCheckAt: check.nextCheckAt,
          state: check.state,
        })
        .where(eq(subscriptions.id, claim.id));
      return "quiet" as const;
    }
    if (
      check.kind === "failed" &&
      current.failures + 1 < maximumSubscriptionFailures
    ) {
      await transaction
        .update(subscriptions)
        .set({
          ...counted,
          failures: current.failures + 1,
          lastError: check.error.slice(0, 500),
          nextCheckAt: check.nextCheckAt,
        })
        .where(eq(subscriptions.id, claim.id));
      return "failed" as const;
    }
    const ended =
      check.kind === "failed"
        ? "failed"
        : check.kind === "hit"
          ? "fired"
          : "expired";
    await transaction
      .update(subscriptions)
      .set({
        ...(check.kind === "expired" ? { updatedAt: now } : counted),
        ...(check.kind === "failed" && {
          failures: current.failures + 1,
          lastError: check.error.slice(0, 500),
        }),
        ...(check.kind === "hit" && {
          hits: sql`${subscriptions.hits} + 1`,
          lastHitAt: now,
        }),
        ...(check.kind !== "failed" && check.state && { state: check.state }),
        status: ended,
      })
      .where(eq(subscriptions.id, claim.id));
    await transaction
      .update(scheduledAgentJobs)
      .set({ lastRunAt: now, status: "completed", updatedAt: now })
      .where(eq(scheduledAgentJobs.id, claim.jobId));
    await transaction.insert(scheduledAgentRuns).values({
      attempts: 1,
      completedAt: now,
      createdAt: now,
      jobId: claim.jobId,
      outcome: check.outcome,
      reportSequence: 1,
      reportStatus: "pending",
      scheduledFor: now,
      startedAt: now,
      status: "completed",
      updatedAt: now,
    });
    return ended;
  });
}

/** The person's watches still checked or paused, newest first. */
export async function listLiveSubscriptions(scope: AccessScope) {
  return db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, scope.workspaceId),
        eq(subscriptions.createdByUserId, scope.userId),
        eq(subscriptions.template, personTemplate),
        inArray(subscriptions.status, [...liveStatuses])
      )
    )
    .orderBy(desc(subscriptions.createdAt));
}

/**
 * Pauses, resumes or deletes one of the person's watches. A resumed watch is
 * checked on the next tick; a deleted one ends with its hidden job. Returns
 * the watch as it now is, or undefined when there is no such live watch.
 */
export async function setSubscriptionStatus(
  scope: AccessScope,
  id: string,
  status: "active" | "deleted" | "paused",
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    const [current] = await transaction
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.id, id),
          eq(subscriptions.workspaceId, scope.workspaceId),
          eq(subscriptions.createdByUserId, scope.userId),
          eq(subscriptions.template, personTemplate),
          inArray(subscriptions.status, [...liveStatuses])
        )
      )
      .for("update");
    if (!current) return undefined;
    const [updated] = await transaction
      .update(subscriptions)
      .set({
        ...(status === "active" &&
          current.status === "paused" && { nextCheckAt: now }),
        status: status === "deleted" ? "cancelled" : status,
        updatedAt: now,
      })
      .where(eq(subscriptions.id, current.id))
      .returning();
    await transaction
      .update(scheduledAgentJobs)
      .set({ status, updatedAt: now })
      .where(eq(scheduledAgentJobs.id, current.jobId));
    return updated;
  });
}

/** The wake rule of the watch a job reports for (`subscriptions.wake`). */
export async function readSubscriptionWake(jobId: string) {
  const [row] = await db
    .select({ wake: subscriptions.wake })
    .from(subscriptions)
    .where(eq(subscriptions.jobId, jobId))
    .limit(1);
  return row?.wake ?? "day_only";
}

/** A flight's watch key: its event and start, as its reminders' keys begin. */
function flightKey(flight: Pick<FlightSource, "eventId" | "start">) {
  return `${flight.eventId}@${flight.start}`;
}

/**
 * Keeps one watch per upcoming flight the proactive check read from the
 * calendar (`agent/schedules/proactive.ts`), on the workspace's proactive
 * job: a flight without a watch, live or ended, gets one due now. A watched
 * flight the calendar no longer shows within `seenUntil` (what the read
 * fully covered) was moved or cancelled, and its watch is removed: should
 * it come back — an edit undone, a page that left it out — it gets a new
 * one, and the reminders already handed over are not handed over again
 * (`proactive_signals`). A moved flight is a new key, so its reminders come
 * again. Returns how many watches started and ended.
 */
export async function syncFlightWatches(input: {
  readonly flights: readonly FlightSource[];
  readonly jobId: string;
  readonly now: Date;
  readonly scope: AccessScope;
  /** Until when the calendar read covered: a flight past it is not gone. */
  readonly seenUntil: Date;
}) {
  return db.transaction(async (transaction) => {
    // Every watch of a flight not yet gone, ended ones too: a flight whose
    // reminders all went out keeps its ended watch, and gets no new one.
    const known = await transaction
      .select({
        dedupeKey: subscriptions.dedupeKey,
        expiresAt: subscriptions.expiresAt,
        id: subscriptions.id,
        status: subscriptions.status,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, input.scope.workspaceId),
          eq(subscriptions.template, "flight"),
          gt(subscriptions.expiresAt, input.now)
        )
      )
      .for("update");
    const keys = new Set(input.flights.map(flightKey));
    const gone = known.filter(
      (watch) =>
        (watch.status === "active" || watch.status === "paused") &&
        !keys.has(watch.dedupeKey) &&
        watch.expiresAt.getTime() <= input.seenUntil.getTime()
    );
    if (gone.length > 0) {
      await transaction.delete(subscriptions).where(
        inArray(
          subscriptions.id,
          gone.map((watch) => watch.id)
        )
      );
    }
    const watched = new Set(known.map((watch) => watch.dedupeKey));
    const fresh = input.flights.filter(
      (flight) =>
        !watched.has(flightKey(flight)) &&
        Date.parse(flight.start) > input.now.getTime()
    );
    let started = 0;
    if (fresh.length > 0) {
      const inserted = await transaction
        .insert(subscriptions)
        .values(
          fresh.map((flight) => ({
            action: "worker" as const,
            checkEverySeconds: 60 * 60,
            condition: { kind: "reminders" as const },
            createdAt: input.now,
            createdByUserId: input.scope.userId,
            dedupeKey: flightKey(flight),
            expiresAt: new Date(flight.start),
            jobId: input.jobId,
            nextCheckAt: input.now,
            source: flight,
            state: { done: [] },
            template: "flight" as const,
            updatedAt: input.now,
            // For the record only: a flight's reminders are proactive runs,
            // timed as those (`proactiveReportTiming`).
            wake: "urgent_at_night" as const,
            workspaceId: input.scope.workspaceId,
          }))
        )
        // A concurrent check started the same watch first.
        .onConflictDoNothing()
        .returning({ id: subscriptions.id });
      started = inserted.length;
    }
    return { ended: gone.length, started };
  });
}

/**
 * Writes what a flight's check decided, while the claim's lease is still
 * the watch's: its next look and state, or its end. A flight's watch never
 * reports through its job: its reminders go to proactive runs.
 */
export async function settleFlightWatch(
  claim: Pick<ClaimedSubscription, "id" | "leaseUntil">,
  outcome:
    | {
        readonly kind: "next";
        readonly nextCheckAt: Date;
        readonly state: FlightState;
      }
    | {
        readonly kind: "ended";
        readonly state?: FlightState;
        readonly status: "expired" | "failed" | "fired";
      },
  now = new Date()
) {
  const settled = await db
    .update(subscriptions)
    .set({
      checks: sql`${subscriptions.checks} + 1`,
      lastCheckedAt: now,
      updatedAt: now,
      ...(outcome.state && { state: outcome.state }),
      ...(outcome.kind === "next"
        ? { nextCheckAt: outcome.nextCheckAt }
        : { status: outcome.status }),
    })
    .where(
      and(
        eq(subscriptions.id, claim.id),
        eq(subscriptions.template, "flight"),
        eq(subscriptions.status, "active"),
        eq(subscriptions.nextCheckAt, claim.leaseUntil)
      )
    )
    .returning({ id: subscriptions.id });
  return settled.length > 0
    ? outcome.kind === "next"
      ? ("waiting" as const)
      : outcome.status
    : undefined;
}

/**
 * The watches of a workspace's flights by event id, for the facts of a
 * proactive run's reminders: the flight as the calendar gave it and the
 * drive the check measured.
 */
export async function listFlightWatches(
  workspaceId: string,
  eventIds: readonly string[]
) {
  if (eventIds.length === 0) return [];
  return db
    .select({
      condition: subscriptions.condition,
      source: subscriptions.source,
      state: subscriptions.state,
      template: subscriptions.template,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, workspaceId),
        eq(subscriptions.template, "flight"),
        inArray(sql<string>`${subscriptions.source}->>'eventId'`, [...eventIds])
      )
    )
    .orderBy(desc(subscriptions.createdAt));
}

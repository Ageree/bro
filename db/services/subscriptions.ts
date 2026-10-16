import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import type { ScheduledRunOutcome } from "@shared/schedules/outcome";
import type { FlightSource, FlightState } from "@shared/subscriptions/flight";
import {
  type ParcelCondition,
  type ParcelSource,
  type ParcelState,
  parcelCheckEverySeconds,
  parcelWatchDays,
  unreadParcelState,
} from "@shared/subscriptions/parcel";
import type {
  PlaceCondition,
  PlaceSource,
  PlaceState,
} from "@shared/subscriptions/place";
import type {
  PriceCondition,
  PriceSource,
  PriceState,
} from "@shared/subscriptions/price";
import { db, scheduledAgentJobs, scheduledAgentRuns, subscriptions } from "@db";

/** The statuses of a watch still checked, or able to be resumed. */
const liveStatuses = ["active", "paused"] as const;

/**
 * The watches the person set up and manages (`watch-create`,
 * `place_reminder`, `parcel-watch`): their own hidden job carries the
 * reports. A parcel watch Bro starts from a carrier's letter is the person's
 * too, listed and stopped like one. A flight's watch is Bro's own, on the
 * proactive job, and is neither listed nor changed by the person's tools.
 */
const personTemplates = ["price", "place", "parcel"] as const;

/**
 * When a watch is next due for the subscriptions tick. A place reminder is
 * never read by it: shared points decide it (`evaluatePlaceReminders`), and
 * the tick takes it only when its term ends. A price or a parcel, a period
 * away.
 */
function nextCheckOf(
  template: (typeof personTemplates)[number],
  now: Date,
  checkEverySeconds: number,
  expiresAt: Date
) {
  return template === "place"
    ? expiresAt
    : new Date(now.getTime() + checkEverySeconds * 1_000);
}

/** Failed checks in a row after which a watch stops and the person hears. */
export const maximumSubscriptionFailures = 3;

interface NewSubscriptionBase {
  readonly checkEverySeconds: number;
  readonly conversation: {
    readonly conversationChannel: "eve" | "photon" | "telegram";
    readonly conversationId: string;
  };
  /** How the watch reads in the person's list of schedules. */
  readonly description: string;
  readonly dedupeKey: string;
  readonly expiresAt: Date;
  readonly replyAnchorMessageId?: string;
  /** Whether a hit may wake the person at night (`subscriptions.wake`). */
  readonly wake?: "day_only" | "urgent_at_night";
}

export type NewSubscription = NewSubscriptionBase &
  (
    | {
        readonly condition: PriceCondition;
        readonly source: PriceSource;
        readonly state: PriceState;
        readonly template: "price";
      }
    | {
        readonly condition: PlaceCondition;
        readonly source: PlaceSource;
        readonly state: PlaceState;
        readonly template: "place";
      }
    | {
        readonly condition: ParcelCondition;
        readonly source: ParcelSource;
        readonly state: ParcelState;
        readonly template: "parcel";
      }
  );

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
    const nextCheckAt = nextCheckOf(
      input.template,
      now,
      input.checkEverySeconds,
      input.expiresAt
    );
    const wake = input.wake ?? "day_only";
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
          wake,
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
        wake,
        workspaceId: scope.workspaceId,
      })
      .returning();
    if (!subscription) throw new Error("The watch could not be created.");
    return { created: true, subscription };
  });
}

/**
 * How long a number from a letter is not watched again: a parcel's journey
 * and its storage, with room to spare.
 */
const mailParcelMemoryMs = 120 * 24 * 60 * 60_000;

/**
 * Starts a parcel watch for each number in a carrier's letter that the
 * proactive check read (`agent/schedules/proactive.ts`). A number the person
 * has a watch of — live, or started in the last 120 days, from their words or
 * an earlier letter — gets none: a letter of a parcel already watched,
 * handed over or returned starts nothing. The watch reports where the
 * proactive job does, and is first read on the next tick. Returns how many
 * started.
 */
export async function startMailParcelWatches(input: {
  readonly numbers: readonly string[];
  readonly now: Date;
  readonly proactiveJobId: string;
  readonly scope: AccessScope;
}) {
  const numbers = [...new Set(input.numbers)].toSorted();
  if (numbers.length === 0) return 0;
  const { now, scope } = input;
  return db.transaction(async (transaction) => {
    // The same locks as `createSubscription`, in one order: the person
    // asking for the same number meanwhile waits here, or this waits.
    for (const number of numbers) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Locks are taken in order.
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`subscription:${scope.workspaceId}:${scope.userId}:parcel:${number}`}, 0))`
      );
    }
    const [proactive] = await transaction
      .select({
        conversationChannel: scheduledAgentJobs.conversationChannel,
        conversationId: scheduledAgentJobs.conversationId,
      })
      .from(scheduledAgentJobs)
      .where(eq(scheduledAgentJobs.id, input.proactiveJobId));
    if (!proactive) return 0;
    const known = await transaction
      .select({ dedupeKey: subscriptions.dedupeKey })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, scope.workspaceId),
          eq(subscriptions.createdByUserId, scope.userId),
          eq(subscriptions.template, "parcel"),
          inArray(subscriptions.dedupeKey, numbers),
          or(
            inArray(subscriptions.status, [...liveStatuses]),
            gt(
              subscriptions.createdAt,
              new Date(now.getTime() - mailParcelMemoryMs)
            )
          )
        )
      );
    const watched = new Set(known.map((watch) => watch.dedupeKey));
    const fresh = numbers.filter((number) => !watched.has(number));
    const expiresAt = new Date(
      now.getTime() + parcelWatchDays * 24 * 60 * 60_000
    );
    for (const number of fresh) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each watch needs its own job first.
      const [job] = await transaction
        .insert(scheduledAgentJobs)
        .values({
          conversationChannel: proactive.conversationChannel,
          conversationId: proactive.conversationId,
          createdAt: now,
          createdByUserId: scope.userId,
          kind: "subscription",
          missedRunPolicy: "skip",
          nextRunAt: null,
          prompt: `Parcel watch: Russian Post ${number}, from Russian Post's letter.`,
          status: "active",
          timing: { at: expiresAt.toISOString(), kind: "once" },
          updatedAt: now,
          workspaceId: scope.workspaceId,
        })
        .returning({ id: scheduledAgentJobs.id });
      if (!job) throw new Error("The parcel's job could not be created.");
      // oxlint-disable-next-line eslint/no-await-in-loop -- The row needs the job just made.
      await transaction.insert(subscriptions).values({
        checkEverySeconds: parcelCheckEverySeconds,
        condition: { kind: "changes" },
        createdAt: now,
        createdByUserId: scope.userId,
        dedupeKey: number,
        expiresAt,
        jobId: job.id,
        nextCheckAt: now,
        source: { carrier: "pochta", number, origin: "mail", title: null },
        state: unreadParcelState(now),
        template: "parcel",
        updatedAt: now,
        workspaceId: scope.workspaceId,
      });
    }
    return fresh.length;
  });
}

/**
 * Marks the person's live parcel watches of these numbers as told: a
 * proactive run carries Russian Post's own letter of each to the person, so
 * the next reading is a baseline, not a second message of the same news
 * (`judgeParcelCheck`). A check in flight meanwhile writes its own state over
 * the mark; that costs one message the letter already gave. Returns how many
 * were marked.
 */
export async function noteParcelLetters(input: {
  readonly numbers: readonly string[];
  readonly now: Date;
  readonly scope: AccessScope;
}) {
  if (input.numbers.length === 0) return 0;
  const marked = await db
    .update(subscriptions)
    .set({
      state: sql`${subscriptions.state} || '{"letterPending":true}'::jsonb`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(subscriptions.workspaceId, input.scope.workspaceId),
        eq(subscriptions.createdByUserId, input.scope.userId),
        eq(subscriptions.template, "parcel"),
        inArray(subscriptions.dedupeKey, [...input.numbers]),
        inArray(subscriptions.status, [...liveStatuses])
      )
    )
    .returning({ id: subscriptions.id });
  return marked.length;
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
          inArray(subscriptions.template, [...personTemplates]),
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
    // Only the person's watches are checked here; a flight's reminders go
    // with the proactive check (`agent/schedules/proactive.ts`).
    const due = await transaction
      .select()
      .from(subscriptions)
      .where(
        and(
          inArray(subscriptions.template, [...personTemplates]),
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

/** What a check of a price or a parcel remembers. */
type CheckedState = ParcelState | PriceState;

/**
 * What one check found:
 * - `quiet`: a reading, nothing to tell; the next check is a period away.
 * - `failed`: no reading. The next check backs off; the third failure in a
 *   row ends the watch with `outcome`, so the person hears once.
 * - `hit`: news for the person (`outcome`); the watch has done its job.
 * - `news`: news for the person (`outcome`), and the watch goes on: a
 *   parcel arrived, and its storage may still run out.
 * - `done`: the watch has done its job with nothing to tell (a parcel
 *   handed over); it ends without a word.
 * - `expired`: the term ran out; `outcome` tells the person.
 * - `held`: not checked now (the workspace left the pilot); the next check
 *   is at `nextCheckAt`, and nothing else changes.
 * - `lapsed`: the term ran out while held; it ends without a word.
 */
export type SubscriptionCheck =
  | {
      readonly kind: "expired" | "hit";
      readonly outcome: ScheduledRunOutcome;
      readonly state?: CheckedState;
    }
  | {
      readonly kind: "news";
      readonly nextCheckAt: Date;
      readonly outcome: ScheduledRunOutcome;
      readonly state: CheckedState;
    }
  | { readonly kind: "done"; readonly state: CheckedState }
  | {
      readonly kind: "failed";
      readonly error: string;
      readonly nextCheckAt: Date;
      readonly outcome: ScheduledRunOutcome;
    }
  | {
      readonly kind: "quiet";
      readonly nextCheckAt: Date;
      readonly state: CheckedState;
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
      if (isPersonTemplate(current.template)) {
        await transaction
          .update(scheduledAgentJobs)
          .set({ status: "completed", updatedAt: now })
          .where(eq(scheduledAgentJobs.id, claim.jobId));
      }
      return "lapsed" as const;
    }
    // Only a person's watch reports through its own job.
    if (!isPersonTemplate(current.template)) return undefined;
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
    if (check.kind === "done") {
      await transaction
        .update(subscriptions)
        .set({
          ...counted,
          failures: 0,
          lastError: null,
          state: check.state,
          status: "fired",
        })
        .where(eq(subscriptions.id, claim.id));
      await transaction
        .update(scheduledAgentJobs)
        .set({ status: "completed", updatedAt: now })
        .where(eq(scheduledAgentJobs.id, claim.jobId));
      return "done" as const;
    }
    if (check.kind === "news") {
      await transaction
        .update(subscriptions)
        .set({
          ...counted,
          failures: 0,
          hits: sql`${subscriptions.hits} + 1`,
          lastError: null,
          lastHitAt: now,
          nextCheckAt: check.nextCheckAt,
          state: check.state,
        })
        .where(eq(subscriptions.id, claim.id));
      // The job stays active: it carries the reports still to come.
      await transaction
        .update(scheduledAgentJobs)
        .set({ lastRunAt: now, updatedAt: now })
        .where(eq(scheduledAgentJobs.id, claim.jobId));
      await transaction
        .insert(scheduledAgentRuns)
        .values(reportRun(claim, check.outcome, now));
      return "news" as const;
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
    await transaction
      .insert(scheduledAgentRuns)
      .values(reportRun(claim, check.outcome, now));
    return ended;
  });
}

/**
 * A run of a watch's job written already finished, its report pending: the
 * schedule tick (`agent/schedules/dynamic.ts`) delivers it like any other.
 */
function reportRun(
  claim: Pick<ClaimedSubscription, "jobId">,
  outcome: ScheduledRunOutcome,
  now: Date
) {
  return {
    attempts: 1,
    completedAt: now,
    createdAt: now,
    jobId: claim.jobId,
    outcome,
    reportSequence: 1,
    reportStatus: "pending" as const,
    scheduledFor: now,
    startedAt: now,
    status: "completed" as const,
    updatedAt: now,
  };
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Ends a place reminder that fired on a shared point
 * (`evaluatePlaceReminders` in `db/services/location.ts`), inside that
 * transaction: the reminder is `fired` with its last state, its job is done,
 * and the report is a finished run, as `settleSubscriptionCheck` writes one.
 * `suppressed`: the person's own turn already says it.
 */
export async function recordPlaceHit(
  transaction: Transaction,
  hit: {
    readonly id: string;
    readonly jobId: string;
    readonly now: Date;
    readonly outcome: ScheduledRunOutcome;
    readonly reportStatus: "pending" | "suppressed";
    readonly state: PlaceState;
  }
) {
  await transaction
    .update(subscriptions)
    .set({
      checks: sql`${subscriptions.checks} + 1`,
      hits: sql`${subscriptions.hits} + 1`,
      lastCheckedAt: hit.now,
      lastHitAt: hit.now,
      state: hit.state,
      status: "fired",
      updatedAt: hit.now,
    })
    .where(eq(subscriptions.id, hit.id));
  await transaction
    .update(scheduledAgentJobs)
    .set({ lastRunAt: hit.now, status: "completed", updatedAt: hit.now })
    .where(eq(scheduledAgentJobs.id, hit.jobId));
  await transaction.insert(scheduledAgentRuns).values({
    attempts: 1,
    completedAt: hit.now,
    createdAt: hit.now,
    jobId: hit.jobId,
    outcome: hit.outcome,
    reportSequence: 1,
    reportStatus: hit.reportStatus,
    scheduledFor: hit.now,
    startedAt: hit.now,
    status: "completed",
    updatedAt: hit.now,
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
        inArray(subscriptions.template, [...personTemplates]),
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
          inArray(subscriptions.template, [...personTemplates]),
          inArray(subscriptions.status, [...liveStatuses])
        )
      )
      .for("update");
    if (!current) return undefined;
    const [updated] = await transaction
      .update(subscriptions)
      .set({
        // A resumed place reminder still waits for its term, not the tick.
        ...(status === "active" &&
          current.status === "paused" && {
            nextCheckAt: current.template === "place" ? current.expiresAt : now,
          }),
        // Points were not run while it was paused: its side is unknown, so
        // the first arrival after resuming is not taken for staying.
        ...(status === "active" &&
          current.status === "paused" &&
          current.template === "place" && {
            state: sql`${subscriptions.state} || '{"inside":null,"changedAt":null,"pending":null}'::jsonb`,
          }),
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

function isPersonTemplate(template: string) {
  return personTemplates.some((person) => person === template);
}

/**
 * How the watch a job reports for may reach the person: its wake rule
 * (`subscriptions.wake`), and whether Bro started it unasked, from Russian
 * Post's own letter (`startMailParcelWatches`).
 */
export async function readSubscriptionDelivery(jobId: string) {
  const [row] = await db
    .select({
      unasked: sql<boolean>`${subscriptions.template} = 'parcel' AND ${subscriptions.source}->>'origin' = 'mail'`,
      wake: subscriptions.wake,
    })
    .from(subscriptions)
    .where(eq(subscriptions.jobId, jobId))
    .limit(1);
  return { unasked: row?.unasked === true, wake: row?.wake ?? "day_only" };
}

/** A flight's watch key: its event and start, as its reminders' keys begin. */
function flightKey(flight: Pick<FlightSource, "eventId" | "start">) {
  return `${flight.eventId}@${flight.start}`;
}

/**
 * A flight's watch is never due for the subscriptions tick: its reminders
 * go with the proactive check. So a release that does not know flights
 * (#277) never takes one for a price watch either.
 */
const flightNeverDue = new Date("9999-12-31T00:00:00.000Z");

/** A flight watch's hidden job: it carries no runs; it only owns the row. */
const flightJobPrompt =
  "Напомнить о рейсе из календаря накануне и к открытию регистрации.";

/**
 * Keeps one watch per upcoming flight the proactive check read from the
 * calendar (`agent/schedules/proactive.ts`), each on a hidden job of its
 * own, never the proactive one: a flight without a watch, live or ended,
 * gets one. A watch of a flight already gone ends; a watched flight the
 * calendar no longer shows before `seenUntil` (what the read fully covered)
 * was moved or cancelled, and goes with its job: should it come back — an
 * edit undone, a page that left it out — it gets a new one, and reminders
 * already handed over are not handed over again (`proactive_signals`).
 * Returns how many watches started and ended.
 */
export async function syncFlightWatches(input: {
  readonly flights: readonly FlightSource[];
  readonly now: Date;
  readonly scope: AccessScope;
  /** Until when the calendar read covered: a flight from it on is not gone. */
  readonly seenUntil: Date;
}) {
  return db.transaction(async (transaction) => {
    // Two checks of one workspace keep its watches one at a time.
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`flight-watches:${input.scope.workspaceId}`}, 0))`
    );
    const departed = await transaction
      .update(subscriptions)
      .set({
        status: sql`CASE WHEN jsonb_array_length(${subscriptions.state}->'done') > 0 THEN 'fired' ELSE 'expired' END`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(subscriptions.workspaceId, input.scope.workspaceId),
          eq(subscriptions.template, "flight"),
          eq(subscriptions.status, "active"),
          lte(subscriptions.expiresAt, input.now)
        )
      )
      .returning({ jobId: subscriptions.jobId });
    if (departed.length > 0) {
      await transaction
        .update(scheduledAgentJobs)
        .set({ status: "completed", updatedAt: input.now })
        .where(
          inArray(
            scheduledAgentJobs.id,
            departed.map((watch) => watch.jobId)
          )
        );
    }
    // Every watch of a flight not yet gone, ended ones too: a flight whose
    // reminders all went out keeps its watch, and gets no new one.
    const known = await transaction
      .select({
        dedupeKey: subscriptions.dedupeKey,
        expiresAt: subscriptions.expiresAt,
        jobId: subscriptions.jobId,
        status: subscriptions.status,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, input.scope.workspaceId),
          eq(subscriptions.template, "flight"),
          gt(subscriptions.expiresAt, input.now)
        )
      );
    const keys = new Set(input.flights.map(flightKey));
    const gone = known.filter(
      (watch) =>
        watch.status === "active" &&
        !keys.has(watch.dedupeKey) &&
        watch.expiresAt.getTime() < input.seenUntil.getTime()
    );
    if (gone.length > 0) {
      // The row goes with its job.
      await transaction.delete(scheduledAgentJobs).where(
        inArray(
          scheduledAgentJobs.id,
          gone.map((watch) => watch.jobId)
        )
      );
    }
    const watched = new Set(known.map((watch) => watch.dedupeKey));
    const fresh = input.flights.filter(
      (flight) =>
        !watched.has(flightKey(flight)) &&
        Date.parse(flight.start) > input.now.getTime()
    );
    for (const flight of fresh) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each watch needs its own job first.
      const [job] = await transaction
        .insert(scheduledAgentJobs)
        .values({
          conversationChannel: "eve",
          conversationId: `flight:${flightKey(flight)}`,
          createdAt: input.now,
          createdByUserId: input.scope.userId,
          kind: "subscription",
          missedRunPolicy: "skip",
          nextRunAt: null,
          prompt: flightJobPrompt,
          status: "active",
          timing: { at: flight.start, kind: "once" },
          updatedAt: input.now,
          workspaceId: input.scope.workspaceId,
        })
        .returning({ id: scheduledAgentJobs.id });
      if (!job) throw new Error("The flight's job could not be created.");
      // oxlint-disable-next-line eslint/no-await-in-loop -- The row needs the job just made.
      await transaction.insert(subscriptions).values({
        action: "worker",
        checkEverySeconds: 60 * 60,
        condition: { kind: "reminders" },
        createdAt: input.now,
        createdByUserId: input.scope.userId,
        dedupeKey: flightKey(flight),
        expiresAt: new Date(flight.start),
        jobId: job.id,
        nextCheckAt: flightNeverDue,
        source: flight,
        state: { done: [] },
        template: "flight",
        updatedAt: input.now,
        // For the record only: a flight's reminders are proactive runs,
        // timed as those (`proactiveReportTiming`).
        wake: "urgent_at_night",
        workspaceId: input.scope.workspaceId,
      });
    }
    return { ended: gone.length + departed.length, started: fresh.length };
  });
}

/** A workspace's live flight watches, for the reminders due now. */
export async function listLiveFlightWatches(workspaceId: string) {
  return db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, workspaceId),
        eq(subscriptions.template, "flight"),
        eq(subscriptions.status, "active")
      )
    );
}

/**
 * Writes what the proactive check learned of its flights' watches: the
 * reminders handed to a run, the drive it measured. Only a live watch.
 */
export async function recordFlightWatch(
  id: string,
  state: FlightState,
  now = new Date()
) {
  await db
    .update(subscriptions)
    .set({
      checks: sql`${subscriptions.checks} + 1`,
      lastCheckedAt: now,
      state,
      updatedAt: now,
    })
    .where(
      and(
        eq(subscriptions.id, id),
        eq(subscriptions.template, "flight"),
        eq(subscriptions.status, "active")
      )
    );
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

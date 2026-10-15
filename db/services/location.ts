import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { env } from "@shared/environment";
import {
  distanceM,
  type FencePoint,
  placeStep,
} from "@shared/location/geometry";
import {
  placeConditionSchema,
  placeHitOutcome,
  placeSourceSchema,
  placeStateSchema,
} from "@shared/subscriptions/place";
import { db, locationPoints, scheduledAgentJobs, subscriptions } from "@db";
import { recordPlaceHit } from "./subscriptions";
import { readWorkspaceTimeZone } from "./user-profile";

/**
 * The person's shared locations (`location_points`, `docs/location.md`) and
 * the geofence of their place reminders. Every point here came from their
 * own message on a trusted channel path; nothing the model, a page or an
 * email says is ever written.
 */

/** How long a shared point is kept. */
export const locationRetentionDays = 90;
/**
 * A live share's raw track is kept this long; older, one point per
 * `liveThinSeconds` of each share is left, enough for where the person
 * stayed and went.
 */
const liveTrackRawDays = 7;
const liveThinSeconds = 600;
/** How long a reminder that ended keeps its job, runs and their addresses. */
const endedReminderDays = 30;
/** Rows one delete takes, so a sweep never holds the table for long. */
const expiryBatch = 5_000;
/** A live share is going while an edit of it is this fresh. */
const liveFreshMs = 10 * 60_000;
/** A point this close with an address lends it to a new one. */
const addressNearM = 30;

const dayMs = 24 * 60 * 60_000;

/** Whether geolocation is on for the workspace (`LOCATION_WORKSPACES`). */
export function locationPilot(scope: Pick<AccessScope, "workspaceId">) {
  return (env.LOCATION_WORKSPACES ?? []).some(
    (entry) => entry === "*" || entry === scope.workspaceId
  );
}

type NewPoint = Omit<
  typeof locationPoints.$inferInsert,
  "createdAt" | "id" | "workspaceId"
>;

/** A point the person shared, with what it may say to the geofence. */
export type SharedPoint = NewPoint &
  Pick<FencePoint, "arriveAllowed" | "leaveAllowed" | "live">;

/**
 * Stores one shared point, or nothing when the same message was already
 * stored (eve does not check Telegram's update ids, and the bridge may hand
 * one update over twice after a restart). Returns the new row.
 */
export async function insertPoint(scope: AccessScope, point: NewPoint) {
  const [row] = await db
    .insert(locationPoints)
    .values({ ...point, workspaceId: scope.workspaceId })
    .onConflictDoNothing({
      target: [locationPoints.workspaceId, locationPoints.externalId],
    })
    .returning();
  return row;
}

/**
 * The latest place the person was, as they shared it: the latest `position`,
 * or with `label` the latest of their own positions they named so
 * («парковка»): a forwarded venue or a friend's card titled «Дом» is a
 * place they talk about, never theirs.
 * `live`: an edit of its Telegram live share is still fresh.
 */
export async function latestPosition(
  scope: AccessScope,
  options: { readonly label?: string; readonly now?: Date } = {}
) {
  const [point] = await db
    .select()
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.workspaceId, scope.workspaceId),
        eq(locationPoints.kind, "position"),
        options.label === undefined
          ? undefined
          : sql`lower(${locationPoints.label}) = lower(${options.label})`
      )
    )
    .orderBy(desc(locationPoints.recordedAt))
    .limit(1);
  if (!point) return undefined;
  const now = options.now ?? new Date();
  const live =
    point.liveKey !== null &&
    (
      await db
        .select({ id: locationPoints.id })
        .from(locationPoints)
        .where(
          and(
            eq(locationPoints.workspaceId, scope.workspaceId),
            eq(locationPoints.liveKey, point.liveKey),
            eq(locationPoints.source, "telegram_live"),
            gte(
              locationPoints.recordedAt,
              new Date(now.getTime() - liveFreshMs)
            )
          )
        )
        .limit(1)
    ).length > 0;
  return { live, point };
}

/**
 * The person's own positions recorded in `[from, to)`, oldest first, for the
 * history of where they stayed and went (`location_history`). A venue is
 * left out: it says where they probably were, not a track. Read newest
 * first, so a cut keeps the latest; `truncated` says one happened.
 */
export async function listLocationPoints(
  scope: AccessScope,
  range: { readonly from: Date; readonly limit: number; readonly to: Date }
) {
  const rows = await db
    .select()
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.workspaceId, scope.workspaceId),
        eq(locationPoints.kind, "position"),
        sql`${locationPoints.source} <> 'telegram_venue'`,
        gte(locationPoints.recordedAt, range.from),
        lt(locationPoints.recordedAt, range.to)
      )
    )
    .orderBy(desc(locationPoints.recordedAt))
    .limit(range.limit + 1);
  return {
    points: rows.slice(0, range.limit).toReversed(),
    truncated: rows.length > range.limit,
  };
}

/**
 * The latest stored point of one Telegram live share (its first point from
 * the message, or an edit): what the next edit is compared with.
 */
export async function recentLiveWrite(scope: AccessScope, liveKey: string) {
  const [point] = await db
    .select({
      lat: locationPoints.lat,
      lon: locationPoints.lon,
      recordedAt: locationPoints.recordedAt,
    })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.workspaceId, scope.workspaceId),
        eq(locationPoints.liveKey, liveKey)
      )
    )
    .orderBy(desc(locationPoints.recordedAt))
    .limit(1);
  return point;
}

/** The latest point the web chat's button shared since `since`. */
export async function latestWebShare(scope: AccessScope, since: Date) {
  const [point] = await db
    .select()
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.workspaceId, scope.workspaceId),
        eq(locationPoints.source, "web"),
        gte(locationPoints.recordedAt, since)
      )
    )
    .orderBy(desc(locationPoints.recordedAt))
    .limit(1);
  return point;
}

/** The web chat's button shares at most one point this often. */
const webShareGapMs = 10_000;
/** A browser's point this coarse may not say the person arrived. */
const webArriveAccuracyM = 100;

/**
 * Stores the point the web chat's button shared and runs it through the
 * place reminders (a hit's report waits for the schedule tick). A browser
 * says nothing of leaving (a laptop's point jumps by kilometres behind a
 * VPN), and arrives only with a fine point. One share per 10 s: the
 * redelivery key is the 10-second slot, so two at once store one.
 */
export async function recordWebShare(
  scope: AccessScope,
  input: {
    readonly accuracyM: number | null;
    readonly lat: number;
    readonly lon: number;
  },
  now = new Date()
) {
  const recent = await latestWebShare(
    scope,
    new Date(now.getTime() - webShareGapMs)
  );
  if (recent) return { shared: false };
  const { row } = await recordShared(
    scope,
    {
      accuracyM: input.accuracyM,
      address: null,
      arriveAllowed:
        input.accuracyM !== null && input.accuracyM <= webArriveAccuracyM,
      externalId: `web:${String(Math.floor(now.getTime() / webShareGapMs))}`,
      kind: "position",
      label: null,
      lat: input.lat,
      leaveAllowed: false,
      live: false,
      liveKey: null,
      lon: input.lon,
      recordedAt: now,
      source: "web",
    },
    { now, via: "web" }
  );
  return { shared: row !== undefined };
}

/** The latest point of any kind the person shared since `since`. */
export async function latestSharedPoint(scope: AccessScope, since: Date) {
  const [point] = await db
    .select()
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.workspaceId, scope.workspaceId),
        gte(locationPoints.recordedAt, since)
      )
    )
    .orderBy(desc(locationPoints.recordedAt))
    .limit(1);
  return point;
}

/**
 * Whether a Telegram live share's edits ever reached Bro in the last 30
 * days: only then may a reminder promise to notice the person on the way.
 */
export async function liveSharingSeen(scope: AccessScope, now = new Date()) {
  const rows = await db
    .select({ id: locationPoints.id })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.workspaceId, scope.workspaceId),
        eq(locationPoints.source, "telegram_live"),
        gte(locationPoints.recordedAt, new Date(now.getTime() - 30 * dayMs))
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** Whether the workspace ever shared a point before (the privacy line). */
export async function sharedBefore(scope: AccessScope, exceptId: string) {
  const rows = await db
    .select({ id: locationPoints.id })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.workspaceId, scope.workspaceId),
        sql`${locationPoints.id} <> ${exceptId}`
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The address of the person's own nearest point within 30 m, without asking
 * any map: a point shared where they have been before reads its address here.
 * Only their own positions lend one: a forwarded venue's address is what its
 * sender wrote, not where the person is.
 */
export async function cachedAddressNear(
  scope: AccessScope,
  lat: number,
  lon: number,
  now = new Date()
) {
  const latSpan = addressNearM / 111_000;
  const lonSpan = latSpan / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  const rows = await db
    .select({
      address: locationPoints.address,
      lat: locationPoints.lat,
      lon: locationPoints.lon,
    })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.workspaceId, scope.workspaceId),
        eq(locationPoints.kind, "position"),
        sql`${locationPoints.address} IS NOT NULL`,
        sql`${locationPoints.lat} BETWEEN ${lat - latSpan} AND ${lat + latSpan}`,
        sql`${locationPoints.lon} BETWEEN ${lon - lonSpan} AND ${lon + lonSpan}`,
        gte(
          locationPoints.recordedAt,
          new Date(now.getTime() - locationRetentionDays * dayMs)
        )
      )
    )
    .limit(50);
  const nearest = rows
    .map((row) => ({
      address: row.address,
      distance: distanceM(row, { lat, lon }),
    }))
    .filter((row) => row.distance <= addressNearM)
    .toSorted((left, right) => left.distance - right.distance)[0];
  return nearest?.address ?? undefined;
}

/** Writes the address a point was found to have. */
export async function setPointAddress(id: string, address: string) {
  await db
    .update(locationPoints)
    .set({ address: address.slice(0, 200) })
    .where(eq(locationPoints.id, id));
}

/** Names one of the workspace's points in the person's words. */
export async function labelPoint(
  scope: AccessScope,
  id: string,
  label: string
) {
  const [row] = await db
    .update(locationPoints)
    .set({ label })
    .where(
      and(
        eq(locationPoints.id, id),
        eq(locationPoints.workspaceId, scope.workspaceId)
      )
    )
    .returning({ id: locationPoints.id });
  return row !== undefined;
}

/** The place reminders' statuses after which a reminder is over. */
const liveStatuses = ["active", "paused"] as const;

/**
 * Deletes the workspace's shared points, all of them or those recorded in
 * `[from, to)`. It also deletes the reminders at places that are over, with
 * their reports: their state and outcomes carry where the person was. A live
 * reminder is a schedule of theirs and stays, but forgets the points it saw
 * (`last`, `pending` and their times); whether the person is inside stays,
 * so it still notices the next crossing. Returns how many points and
 * reminders went.
 */
export async function forgetLocation(
  workspaceId: string,
  range: { readonly from?: Date; readonly to?: Date } = {}
) {
  const deleted = await db
    .delete(locationPoints)
    .where(
      and(
        eq(locationPoints.workspaceId, workspaceId),
        range.from === undefined
          ? undefined
          : gte(locationPoints.recordedAt, range.from),
        range.to === undefined
          ? undefined
          : lt(locationPoints.recordedAt, range.to)
      )
    )
    .returning({ id: locationPoints.id });
  await db
    .update(subscriptions)
    .set({
      state: sql`${subscriptions.state} || '{"last":null,"pending":null,"recentOut":null,"farAt":null}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(subscriptions.workspaceId, workspaceId),
        eq(subscriptions.template, "place"),
        inArray(subscriptions.status, [...liveStatuses])
      )
    );
  const reminders = await deleteEndedReminders(workspaceId);
  return { points: deleted.length, reminders };
}

/**
 * Deletes the jobs of place reminders that are over (a fired, expired,
 * cancelled or failed one), of one workspace or, with `before`, of every
 * workspace once they ended that long ago. The reminder and its runs go
 * with the job.
 */
async function deleteEndedReminders(workspaceId?: string, before?: Date) {
  const ended = await db
    .select({ jobId: subscriptions.jobId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.template, "place"),
        notInArray(subscriptions.status, [...liveStatuses]),
        workspaceId === undefined
          ? undefined
          : eq(subscriptions.workspaceId, workspaceId),
        before === undefined ? undefined : lte(subscriptions.updatedAt, before)
      )
    )
    .limit(expiryBatch);
  if (ended.length === 0) return 0;
  await db.delete(scheduledAgentJobs).where(
    inArray(
      scheduledAgentJobs.id,
      ended.map((row) => row.jobId)
    )
  );
  return ended.length;
}

/**
 * The hourly sweep (`agent/schedules/memory-history.ts`): points older than
 * 90 days, in batches until none is left, a live share's track older than
 * a week thinned to a point per 10 minutes (a point the person named stays),
 * and the jobs of place reminders that ended more than 30 days ago.
 */
export async function expireLocationPoints(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - locationRetentionDays * dayMs);
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One batch at a time keeps each delete short.
    const removed = await db
      .delete(locationPoints)
      .where(
        inArray(
          locationPoints.id,
          db
            .select({ id: locationPoints.id })
            .from(locationPoints)
            .where(lt(locationPoints.recordedAt, cutoff))
            .limit(expiryBatch)
        )
      )
      .returning({ id: locationPoints.id });
    if (removed.length < expiryBatch) break;
  }
  const rawBefore = new Date(now.getTime() - liveTrackRawDays * dayMs);
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One batch at a time keeps each delete short.
    const thinned = await db.execute(sql`
      DELETE FROM ${locationPoints}
      WHERE ${locationPoints.id} IN (
        SELECT ranked.id FROM (
          SELECT ${locationPoints.id} AS id, row_number() OVER (
            PARTITION BY ${locationPoints.workspaceId}, ${locationPoints.liveKey},
              floor(extract(epoch FROM ${locationPoints.recordedAt}) / ${liveThinSeconds})
            ORDER BY ${locationPoints.recordedAt}
          ) AS place
          FROM ${locationPoints}
          WHERE ${locationPoints.source} = 'telegram_live'
            AND ${locationPoints.label} IS NULL
            AND ${locationPoints.recordedAt} < ${rawBefore}
        ) ranked
        WHERE ranked.place > 1
        LIMIT ${expiryBatch}
      )
      RETURNING ${locationPoints.id}
    `);
    if (thinned.rows.length < expiryBatch) break;
  }
  const endedBefore = new Date(now.getTime() - endedReminderDays * dayMs);
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One batch at a time keeps each delete short.
    const removed = await deleteEndedReminders(undefined, endedBefore);
    if (removed < expiryBatch) break;
  }
}

/** A reminder that fired on a point. */
export interface PlaceHit {
  readonly at: Date;
  readonly label: string;
  readonly on: "arrive" | "leave";
  readonly subscriptionId: string;
  readonly text: string;
}

/**
 * Runs one shared position through the workspace's live place reminders,
 * in one transaction that locks them: two points at once cannot both fire
 * one. Each reminder's state is written; a hit ends it and writes its
 * report as a finished run. `via: "message"`: the person's own message
 * carries the point, their turn is opening and says it (the channel's
 * context line), so the report is `suppressed`, not a second message a
 * minute later. Otherwise the report is `pending` for the schedule tick.
 */
export async function evaluatePlaceReminders(
  scope: AccessScope,
  point: FencePoint,
  options: { readonly now?: Date; readonly via: "live" | "message" | "web" }
): Promise<readonly PlaceHit[]> {
  const now = options.now ?? new Date();
  // Read before the reminders are locked: a hit's report names the time on
  // the person's clock, and the transaction holds its connection.
  const timeZone = await readWorkspaceTimeZone(scope);
  return db.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, scope.workspaceId),
          eq(subscriptions.template, "place"),
          eq(subscriptions.status, "active"),
          gt(subscriptions.expiresAt, now)
        )
      )
      .for("update");
    const hits: PlaceHit[] = [];
    for (const row of rows) {
      const source = placeSourceSchema.safeParse(row.source).data;
      const condition = placeConditionSchema.safeParse(row.condition).data;
      const state = placeStateSchema.safeParse(row.state).data;
      if (!source || !condition || !state) continue;
      const step = placeStep(state, point, {
        center: source,
        createdAt: row.createdAt,
        now,
        on: condition.on,
        radiusM: source.radiusM,
      });
      if (!step.hit) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- The reminders are locked in this transaction; there are a few.
        await transaction
          .update(subscriptions)
          .set({ state: step.state, updatedAt: now })
          .where(eq(subscriptions.id, row.id));
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- The hit ends the reminder in this transaction.
      await recordPlaceHit(transaction, {
        id: row.id,
        jobId: row.jobId,
        now,
        outcome: placeHitOutcome({
          at: step.hit.at,
          condition,
          movedFar: step.hit.movedFar,
          source,
          timeZone,
        }),
        reportStatus: options.via === "message" ? "suppressed" : "pending",
        state: step.state,
      });
      hits.push({
        at: step.hit.at,
        label: source.label,
        on: condition.on,
        subscriptionId: row.id,
        text: condition.text,
      });
    }
    return hits;
  });
}

/**
 * Stores a point the person shared and, when it is a new position, runs it
 * through their place reminders. Returns the stored row (undefined for a
 * redelivered one) and the reminders it fired.
 */
export async function recordShared(
  scope: AccessScope,
  point: SharedPoint,
  options: { readonly now?: Date; readonly via: "live" | "message" | "web" }
) {
  const { arriveAllowed, leaveAllowed, live, ...stored } = point;
  const row = await insertPoint(scope, stored);
  if (row?.kind !== "position") return { hits: [], row };
  const hits = await evaluatePlaceReminders(
    scope,
    {
      accuracyM: row.accuracyM,
      arriveAllowed,
      lat: row.lat,
      leaveAllowed,
      live,
      lon: row.lon,
      recordedAt: row.recordedAt,
    },
    options
  );
  return { hits, row };
}

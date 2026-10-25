import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { broReports, broThreads, db } from "@db";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Attempts a report gets before it is dropped. */
const reportAttempts = 5;

/**
 * Queues one report to an owner. The dedupe key names the event, so a
 * repeated tick or step never queues the same report twice.
 */
export async function enqueueBroReport(
  transaction: Transaction,
  report: Pick<
    typeof broReports.$inferInsert,
    | "dedupeKey"
    | "kind"
    | "payload"
    | "target"
    | "threadId"
    | "userId"
    | "workspaceId"
  >
) {
  await transaction
    .insert(broReports)
    .values(report)
    .onConflictDoNothing({ target: broReports.dedupeKey });
}

/**
 * Leases reports due for delivery, oldest first. A report keeps its token
 * for life, as a phone report does: a report turn that waited in the
 * conversation's queue past the lease still settles it. A report whose last
 * attempt never settled is dropped here.
 */
export async function claimBroReports(
  input: { readonly limit: number; readonly leaseMs: number },
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    await transaction
      .update(broReports)
      .set({
        status: "dropped",
        leaseExpiresAt: null,
        lastError: sql`coalesce(${broReports.lastError}, 'no attempts left')`,
      })
      .where(
        and(
          eq(broReports.status, "leased"),
          lte(broReports.leaseExpiresAt, now),
          gte(broReports.attempts, reportAttempts)
        )
      );
    const due = await transaction
      .select({ id: broReports.id, leaseToken: broReports.leaseToken })
      .from(broReports)
      .where(
        and(
          inArray(broReports.status, ["pending", "leased"]),
          or(
            isNull(broReports.leaseExpiresAt),
            lte(broReports.leaseExpiresAt, now)
          ),
          lt(broReports.attempts, reportAttempts)
        )
      )
      .orderBy(asc(broReports.createdAt))
      .limit(input.limit)
      .for("update", { skipLocked: true });
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
    return Promise.all(
      due.map(async (row) => {
        const leaseToken = row.leaseToken ?? randomUUID();
        const [claimed] = await transaction
          .update(broReports)
          .set({
            status: "leased",
            leaseToken,
            leaseExpiresAt,
            attempts: sql`${broReports.attempts} + 1`,
          })
          .where(eq(broReports.id, row.id))
          .returning({
            id: broReports.id,
            workspaceId: broReports.workspaceId,
            userId: broReports.userId,
            threadId: broReports.threadId,
            kind: broReports.kind,
            payload: broReports.payload,
            target: broReports.target,
            attempts: broReports.attempts,
            createdAt: broReports.createdAt,
          });
        if (!claimed) throw new Error("Bro report lease claim lost.");
        return Object.assign(claimed, { leaseToken });
      })
    );
  });
}

/**
 * The report's turn is still on it: its lease runs five minutes more, while
 * the report is this owner's, holds this token and is not settled. False
 * for a copy of a report already delivered, dropped or backed off: that turn
 * says nothing.
 */
export async function renewBroReportLease(
  scope: AccessScope,
  id: string,
  token: string,
  now = new Date()
) {
  const rows = await db
    .update(broReports)
    .set({ leaseExpiresAt: new Date(now.getTime() + 5 * 60_000) })
    .where(
      and(
        eq(broReports.id, id),
        eq(broReports.workspaceId, scope.workspaceId),
        eq(broReports.userId, scope.userId),
        eq(broReports.leaseToken, token),
        eq(broReports.status, "leased")
      )
    )
    .returning({ id: broReports.id });
  return rows.length > 0;
}

/**
 * Settles a report attempt and returns the report's status, or null when the
 * token is not the report's. A failed attempt is retried after a pause that
 * doubles each time, up to five attempts; one that cannot succeed (the
 * owner has no messenger) is dropped at once with its reason.
 */
export async function finishBroReport(
  id: string,
  token: string,
  result:
    | { readonly delivered: true }
    | {
        readonly delivered: false;
        readonly error: string;
        readonly retry: boolean;
      },
  now = new Date()
) {
  if (result.delivered) {
    const rows = await db
      .update(broReports)
      .set({
        status: "delivered",
        deliveredAt: now,
        leaseExpiresAt: null,
        lastError: null,
      })
      .where(
        and(
          eq(broReports.id, id),
          eq(broReports.leaseToken, token),
          ne(broReports.status, "delivered")
        )
      )
      .returning({ status: broReports.status });
    return rows[0]?.status ?? null;
  }
  const retry = result.retry
    ? sql`${broReports.attempts} < ${reportAttempts}`
    : sql`false`;
  const rows = await db
    .update(broReports)
    .set({
      status: sql`CASE WHEN ${retry} THEN 'pending' ELSE 'dropped' END`,
      leaseExpiresAt: sql`CASE WHEN ${retry} THEN ${now.toISOString()}::timestamptz + make_interval(secs => least(60 * power(2, greatest(${broReports.attempts} - 1, 0)), 3600)::int) END`,
      lastError: result.error,
    })
    .where(
      and(
        eq(broReports.id, id),
        eq(broReports.leaseToken, token),
        eq(broReports.status, "leased")
      )
    )
    .returning({ status: broReports.status });
  return rows[0]?.status ?? null;
}

/** How long a report waits for its owner's first chat with Bro (v2). */
const parkedMs = 7 * 24 * 60 * 60_000;
/** How often a waiting report looks for that chat again. */
const parkPauseMs = 15 * 60_000;

/** What waits for an owner in a thread: closing the thread takes it away. */
const awaitingKinds = new Set(["agreed", "held", "question"]);

/**
 * A report of the second version whose owner has no chat with Bro at all —
 * no messenger, no web chat, no Telegram — waits for one instead of being
 * dropped: back to pending in 15 minutes, the attempt not counted, for a
 * week from when it was queued; then it is dropped. A question, a draft or
 * an agreement of a thread that closed meanwhile is dropped at once: the
 * thread is locked first, as closing it does, so the two never cross.
 * Returns the report's status, or null when the token is not the report's.
 */
export async function parkBroReport(
  id: string,
  token: string,
  now = new Date()
) {
  return db.transaction(async (transaction) => {
    const [report] = await transaction
      .select({ kind: broReports.kind, threadId: broReports.threadId })
      .from(broReports)
      .where(
        and(
          eq(broReports.id, id),
          eq(broReports.leaseToken, token),
          eq(broReports.status, "leased")
        )
      )
      .limit(1);
    if (!report) return null;
    const [thread] =
      report.threadId === null
        ? []
        : await transaction
            .select({ closedAt: broThreads.closedAt })
            .from(broThreads)
            .where(eq(broThreads.id, report.threadId))
            .limit(1)
            .for("update");
    const stale =
      awaitingKinds.has(report.kind) &&
      (thread === undefined || thread.closedAt !== null);
    const keep = stale
      ? sql`false`
      : sql`${broReports.createdAt} > ${new Date(now.getTime() - parkedMs).toISOString()}::timestamptz`;
    const rows = await transaction
      .update(broReports)
      .set({
        status: sql`CASE WHEN ${keep} THEN 'pending' ELSE 'dropped' END`,
        attempts: sql`greatest(${broReports.attempts} - 1, 0)`,
        leaseExpiresAt: sql`CASE WHEN ${keep} THEN ${new Date(now.getTime() + parkPauseMs).toISOString()}::timestamptz END`,
        lastError: stale ? "thread closed" : "no chat",
      })
      .where(
        and(
          eq(broReports.id, id),
          eq(broReports.leaseToken, token),
          eq(broReports.status, "leased")
        )
      )
      .returning({ status: broReports.status });
    return rows[0]?.status ?? null;
  });
}

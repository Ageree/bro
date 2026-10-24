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
import { broReports, db } from "@db";

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

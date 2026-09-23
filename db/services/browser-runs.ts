import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { browserProfiles, browserRuns, db } from "@db";
import { ensureScope } from "./scope";

type BrowserRunInsert = typeof browserRuns.$inferInsert;

const activeBrowserRunStatuses = ["created", "running", "waiting"] as const;

// A delivery that has not landed within the lease is presumed dead and may be
// retried; one that failed this many times, or whose run settled this long
// ago, is left for `browser_task status` to surface instead.
const reportLeaseMs = 2 * 60_000;
const maximumReportAttempts = 10;
const reportRetryWindowMs = 24 * 60 * 60_000;

export async function readBrowserProfileId(scope: AccessScope) {
  const rows = await db
    .select({ profileId: browserProfiles.profileId })
    .from(browserProfiles)
    .where(eq(browserProfiles.workspaceId, scope.workspaceId))
    .limit(1);
  return rows[0]?.profileId;
}

/**
 * Claim the workspace's single Browser Use profile. A concurrent caller that
 * already created one wins, and its id is returned, so a race costs an unused
 * remote profile rather than a workspace whose logins are split across two.
 */
export async function saveBrowserProfileId(
  scope: AccessScope,
  profileId: string
) {
  await ensureScope(scope);
  await db
    .insert(browserProfiles)
    .values({ profileId, workspaceId: scope.workspaceId })
    .onConflictDoNothing({ target: browserProfiles.workspaceId });
  return (await readBrowserProfileId(scope)) ?? profileId;
}

export async function createBrowserRun(
  scope: AccessScope,
  input: Omit<BrowserRunInsert, "createdByUserId" | "workspaceId">
) {
  await ensureScope(scope);
  const [row] = await db
    .insert(browserRuns)
    .values({
      ...input,
      createdByUserId: scope.userId,
      workspaceId: scope.workspaceId,
    })
    .returning();
  if (!row) throw new Error("The browser run could not be recorded.");
  return row;
}

export async function readBrowserRunForScope(
  scope: AccessScope,
  runId: string
) {
  const rows = await db
    .select()
    .from(browserRuns)
    .where(
      and(
        eq(browserRuns.id, runId),
        eq(browserRuns.workspaceId, scope.workspaceId)
      )
    )
    .limit(1);
  return rows[0];
}

export async function readBrowserRun(runId: string) {
  const rows = await db
    .select()
    .from(browserRuns)
    .where(eq(browserRuns.id, runId))
    .limit(1);
  return rows[0];
}

export async function updateBrowserRunProgress(
  runId: string,
  input: Pick<Partial<BrowserRunInsert>, "liveViewUrl" | "status">
) {
  await db
    .update(browserRuns)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(browserRuns.id, runId), isNull(browserRuns.completedAt)));
}

/**
 * Settle a run exactly once. The `completed_at IS NULL` guard is what keeps a
 * webhook delivery and the reconciling poller from both reporting the same
 * outcome into the user's conversation; the loser gets `undefined`.
 */
export async function claimBrowserRunCompletion(
  runId: string,
  input: Pick<BrowserRunInsert, "outcome" | "status">
) {
  const completedAt = new Date();
  const [row] = await db
    .update(browserRuns)
    .set({ ...input, completedAt, updatedAt: completedAt })
    .where(and(eq(browserRuns.id, runId), isNull(browserRuns.completedAt)))
    .returning();
  return row;
}

export async function listUnsettledBrowserRuns(options: {
  readonly limit: number;
  readonly staleBefore: Date;
}) {
  return db
    .select()
    .from(browserRuns)
    .where(
      and(
        isNull(browserRuns.completedAt),
        inArray(browserRuns.status, activeBrowserRunStatuses),
        lt(browserRuns.createdAt, options.staleBefore)
      )
    )
    .orderBy(asc(browserRuns.createdAt))
    .limit(options.limit);
}

/**
 * Keep the report a settled run owes its conversation. It stays pending until
 * a delivery lands, so an unreachable conversation delays the report instead
 * of losing it.
 */
export async function saveBrowserRunReport(runId: string, report: string) {
  await db
    .update(browserRuns)
    .set({ report, updatedAt: new Date() })
    .where(eq(browserRuns.id, runId));
}

function reportPending(now: Date) {
  return and(
    isNotNull(browserRuns.report),
    isNull(browserRuns.reportDeliveredAt),
    lt(browserRuns.reportAttempts, maximumReportAttempts),
    gt(browserRuns.completedAt, new Date(now.getTime() - reportRetryWindowMs)),
    or(
      isNull(browserRuns.reportClaimedAt),
      lt(browserRuns.reportClaimedAt, new Date(now.getTime() - reportLeaseMs))
    )
  );
}

/**
 * Take the lease on delivering a pending report. The webhook and the poller
 * can both reach for the same report; only the holder of a fresh lease sends.
 */
export async function claimBrowserRunReport(runId: string) {
  const now = new Date();
  const [row] = await db
    .update(browserRuns)
    .set({
      reportAttempts: sql`${browserRuns.reportAttempts} + 1`,
      reportClaimedAt: now,
      updatedAt: now,
    })
    .where(and(eq(browserRuns.id, runId), reportPending(now)))
    .returning();
  return row;
}

export async function finishBrowserRunReport(runId: string) {
  const now = new Date();
  await db
    .update(browserRuns)
    .set({ reportClaimedAt: null, reportDeliveredAt: now, updatedAt: now })
    .where(
      and(eq(browserRuns.id, runId), isNull(browserRuns.reportDeliveredAt))
    );
}

/** Give the lease back so the next poll retries the delivery at once. */
export async function releaseBrowserRunReport(runId: string) {
  await db
    .update(browserRuns)
    .set({ reportClaimedAt: null, updatedAt: new Date() })
    .where(
      and(eq(browserRuns.id, runId), isNull(browserRuns.reportDeliveredAt))
    );
}

export async function listPendingBrowserRunReports(limit: number) {
  return db
    .select({ id: browserRuns.id })
    .from(browserRuns)
    .where(reportPending(new Date()))
    .orderBy(asc(browserRuns.completedAt))
    .limit(limit);
}

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { browserProfiles, browserRuns, db, spendEntries } from "@db";
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

/**
 * Park a settled run that lost to an anti-bot wall until its background
 * retry is due. The run keeps its completion claim, so neither the webhook nor
 * the poller settles it again; only the retry queue picks it back up.
 */
export async function parkBrowserRunForRetry(
  runId: string,
  input: { readonly captchaAttempt: number; readonly retryAt: Date }
) {
  // A stopped run was cancelled or taken over by the person: parking it again
  // would start an errand they already ended.
  const rows = await db
    .update(browserRuns)
    .set({
      captchaAttempt: input.captchaAttempt,
      retryAt: input.retryAt,
      status: "waiting",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(browserRuns.id, runId),
        isNull(browserRuns.retriedAsRunId),
        ne(browserRuns.status, "stopped")
      )
    )
    .returning({ id: browserRuns.id });
  return rows.length > 0;
}

function retryDue(now: Date) {
  return and(
    isNotNull(browserRuns.retryAt),
    lte(browserRuns.retryAt, now),
    isNull(browserRuns.retriedAsRunId),
    eq(browserRuns.status, "waiting")
  );
}

// Long enough for one retry to start and be handed the errand.
const retryClaimLeaseMs = 10 * 60_000;

/**
 * Take the parked runs whose retry is due. Pushing `retry_at` out by a lease
 * is the claim: a second poller re-evaluates the condition on the updated row
 * and skips it, and a poller that dies before the handoff leaves the row to
 * be claimed again once the lease runs out, rather than losing the errand.
 * The row stays `waiting` until the retry takes it over, so a cancel in the
 * meantime still lands on it and the handoff sees it.
 */
export async function claimDueBrowserRunRetries(now: Date, limit: number) {
  const due = db
    .select({ id: browserRuns.id })
    .from(browserRuns)
    .where(retryDue(now))
    .orderBy(asc(browserRuns.retryAt))
    .limit(limit);
  return db
    .update(browserRuns)
    .set({
      retryAt: new Date(now.getTime() + retryClaimLeaseMs),
      updatedAt: now,
    })
    .where(and(inArray(browserRuns.id, due), retryDue(now)))
    .returning();
}

/**
 * The person ended or took over a settled errand: whatever retry was waiting
 * or being started for it must not go on. True when the row was still one the
 * retry queue could act on.
 */
export async function stopBrowserRunErrand(runId: string) {
  const rows = await db
    .update(browserRuns)
    .set({ retryAt: null, status: "stopped", updatedAt: new Date() })
    .where(
      and(
        eq(browserRuns.id, runId),
        isNotNull(browserRuns.completedAt),
        isNull(browserRuns.retriedAsRunId)
      )
    )
    .returning({ status: browserRuns.status });
  return rows.length > 0;
}

/** The walled errand is over: nothing is parked and nothing will retry. */
export async function finishWalledBrowserRun(runId: string) {
  await db
    .update(browserRuns)
    .set({ retryAt: null, status: "failed", updatedAt: new Date() })
    .where(and(eq(browserRuns.id, runId), isNull(browserRuns.retriedAsRunId)));
}

/**
 * Hand a parked errand to the retry run that was just started for it, in one
 * transaction: the new row, the link from the old one and the spend
 * reservation move together or not at all. False when the old row was
 * stopped in the meantime — the caller then cancels the run it started.
 */
export async function handOffBrowserRunRetry(
  fromRunId: string,
  retry: Omit<BrowserRunInsert, "createdByUserId" | "workspaceId">
) {
  return db.transaction(async (tx) => {
    const [from] = await tx
      .update(browserRuns)
      .set({
        retriedAsRunId: retry.id,
        retryAt: null,
        status: "stopped",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(browserRuns.id, fromRunId),
          eq(browserRuns.status, "waiting"),
          isNull(browserRuns.retriedAsRunId)
        )
      )
      .returning({
        createdByUserId: browserRuns.createdByUserId,
        workspaceId: browserRuns.workspaceId,
      });
    if (!from) return false;
    await tx.insert(browserRuns).values({ ...retry, ...from });
    await tx
      .update(spendEntries)
      .set({ browserRunId: retry.id, updatedAt: new Date() })
      .where(
        and(
          eq(spendEntries.browserRunId, fromRunId),
          eq(spendEntries.status, "reserved")
        )
      );
    return true;
  });
}

// A chain longer than the retry cap is not one this code builds.
const maximumRetryHops = 10;

/**
 * The run that carries the errand now. A background retry replaces a run
 * the conversation still knows by its old id, so a follow-up or a status
 * check addressed to that id is followed to the newest run of the chain.
 */
export async function readLatestBrowserRunForScope(
  scope: AccessScope,
  runId: string,
  hops = 0
): Promise<Awaited<ReturnType<typeof readBrowserRunForScope>>> {
  const row = await readBrowserRunForScope(scope, runId);
  if (!row?.retriedAsRunId || hops >= maximumRetryHops) return row;
  return (
    (await readLatestBrowserRunForScope(scope, row.retriedAsRunId, hops + 1)) ??
    row
  );
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

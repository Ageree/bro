import {
  and,
  asc,
  desc,
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

/**
 * Whether a run's report is owed and nobody is delivering it: kept, not
 * delivered, and with no live lease — a report turn queued or at work in the
 * conversation holds one, and handing the report over beside it would tell
 * the person twice.
 */
export function browserRunReportOwed(
  row: Pick<
    BrowserRunInsert,
    "report" | "reportClaimedAt" | "reportDeliveredAt"
  >,
  now = new Date()
) {
  return (
    row.report !== null &&
    row.report !== undefined &&
    !row.reportDeliveredAt &&
    (!row.reportClaimedAt ||
      row.reportClaimedAt.getTime() < now.getTime() - reportLeaseMs)
  );
}

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
 * Record what the person just approved on the card for a run that is still
 * working, so its later follow-ups carry the same permission.
 */
export async function recordBrowserRunSubmission(
  runId: string,
  submission: NonNullable<BrowserRunInsert["submission"]>
) {
  await db
    .update(browserRuns)
    .set({ submission, updatedAt: new Date() })
    .where(eq(browserRuns.id, runId));
}

/**
 * Settle a run exactly once. The `completed_at IS NULL` guard is what keeps a
 * webhook delivery and the reconciling poller from both reporting the same
 * outcome into the user's conversation; the loser gets `undefined`.
 *
 * A `report` given here is kept in the same write, under a delivery lease the
 * settler holds while it adds the pictures and the spend note. A settle cut
 * off after the claim used to leave a closed run with no report at all:
 * nothing listed it as unsettled, pending or overdue, and the person never
 * heard. Now the plain report is delivered once that lease runs out.
 */
export async function claimBrowserRunCompletion(
  runId: string,
  input: Pick<BrowserRunInsert, "outcome" | "status"> & {
    readonly report?: string;
  }
) {
  const completedAt = new Date();
  const { report, ...settled } = input;
  const [row] = await db
    .update(browserRuns)
    .set({
      ...settled,
      completedAt,
      updatedAt: completedAt,
      // Drizzle leaves an undefined column as it is.
      report,
      reportClaimedAt: report === undefined ? undefined : completedAt,
    })
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
 * Hand a parked or queued errand to the run that was just started for it, in
 * one transaction: the new row, the link from the old one and the spend
 * reservation move together or not at all. False when the old row was
 * stopped in the meantime — the caller then cancels the run it started — or,
 * given the `queueRevision` the run was started from, when the person changed
 * the queued errand since: that run carries the old instruction.
 */
export async function handOffBrowserRunRetry(
  fromRunId: string,
  retry: Omit<BrowserRunInsert, "createdByUserId" | "workspaceId">,
  options: { readonly queueRevision?: number } = {}
) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [from] = await tx
      .update(browserRuns)
      .set({
        // A queued errand never ran: it closes here, so nothing lists it as
        // unsettled, and its composed instruction leaves with it.
        completedAt: sql`coalesce(${browserRuns.completedAt}, ${now})`,
        pendingTask: null,
        retriedAsRunId: retry.id,
        retryAt: null,
        status: "stopped",
        updatedAt: now,
      })
      .where(
        and(
          eq(browserRuns.id, fromRunId),
          inArray(browserRuns.status, ["queued", "waiting"]),
          isNull(browserRuns.retriedAsRunId),
          options.queueRevision === undefined
            ? undefined
            : eq(browserRuns.queueRevision, options.queueRevision)
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

function unsettled(options: {
  readonly checkedBefore: Date;
  readonly staleBefore: Date;
}) {
  return and(
    isNull(browserRuns.completedAt),
    inArray(browserRuns.status, activeBrowserRunStatuses),
    lt(browserRuns.createdAt, options.staleBefore),
    lt(browserRuns.updatedAt, options.checkedBefore)
  );
}

/**
 * Take the next open runs to check against Browser Use: the ones checked
 * longest ago, marked as checked now. Reading them oldest-created first let
 * twenty-five runs that never settle — a run Browser Use no longer knows, one
 * whose status could not be read — hold every slot, so a run that finished
 * after them was not looked at until they expired 45 minutes later. Each
 * take moves what it returns to the back of the line, and a poll takes
 * batches until everything unchecked since `checkedBefore` has had its turn.
 */
export async function takeUnsettledBrowserRuns(options: {
  readonly checkedBefore: Date;
  readonly limit: number;
  readonly now?: Date;
  readonly staleBefore: Date;
}) {
  const next = db
    .select({ id: browserRuns.id })
    .from(browserRuns)
    .where(unsettled(options))
    .orderBy(asc(browserRuns.updatedAt))
    .limit(options.limit);
  const rows = await db
    .update(browserRuns)
    .set({ updatedAt: options.now ?? new Date() })
    .where(and(inArray(browserRuns.id, next), unsettled(options)))
    .returning();
  return rows.toSorted(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime()
  );
}

/**
 * Keep an errand for which Browser Use had no free browser. It holds a
 * `queued:` id until the poller starts its run and hands it over, the way a
 * walled run hands over to its retry.
 */
export async function createQueuedBrowserRun(
  scope: AccessScope,
  input: Omit<
    BrowserRunInsert,
    "createdByUserId" | "id" | "status" | "workspaceId"
  > & {
    readonly pendingTask: string;
    readonly retryAt: Date;
  }
) {
  return createBrowserRun(scope, {
    ...input,
    id: `queued:${crypto.randomUUID()}`,
    status: "queued",
  });
}

function queuedAndDue(now: Date) {
  return and(
    eq(browserRuns.status, "queued"),
    isNull(browserRuns.retriedAsRunId),
    isNotNull(browserRuns.retryAt),
    lte(browserRuns.retryAt, now)
  );
}

/**
 * How many errands wait for a browser, across every workspace. One that waits
 * for its own workspace's sign-in elsewhere (`waits_for_account`) is not
 * waiting for Browser Use and holds nobody else's start back.
 */
export async function countQueuedBrowserRuns() {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(browserRuns)
    .where(
      and(
        eq(browserRuns.status, "queued"),
        isNull(browserRuns.retriedAsRunId),
        isNull(browserRuns.waitsForAccount)
      )
    );
  return row?.count ?? 0;
}

/**
 * Take the errand that has waited longest for a browser, when its next try
 * is due. The claim is the same lease as a walled run's retry: `retry_at`
 * moves out, so a second poller skips it, and a poller that dies leaves it to
 * be taken again once the lease runs out. First come, first started.
 */
export async function claimNextQueuedBrowserRun(now: Date) {
  const next = db
    .select({ id: browserRuns.id })
    .from(browserRuns)
    .where(queuedAndDue(now))
    .orderBy(asc(browserRuns.createdAt))
    .limit(1);
  const [row] = await db
    .update(browserRuns)
    .set({
      retryAt: new Date(now.getTime() + retryClaimLeaseMs),
      updatedAt: now,
    })
    .where(and(inArray(browserRuns.id, next), queuedAndDue(now)))
    .returning();
  return row;
}

/**
 * Put a queued errand back in line until `retryAt`, unless it was stopped.
 * `waitsForAccount` records, or with null clears, the sign-in it waits on.
 */
export async function parkQueuedBrowserRun(
  runId: string,
  retryAt: Date,
  options: { readonly waitsForAccount?: string | null } = {}
) {
  const rows = await db
    .update(browserRuns)
    .set({
      retryAt,
      updatedAt: new Date(),
      waitsForAccount: options.waitsForAccount,
    })
    .where(
      and(
        eq(browserRuns.id, runId),
        eq(browserRuns.status, "queued"),
        isNull(browserRuns.retriedAsRunId)
      )
    )
    .returning({ id: browserRuns.id });
  return rows.length > 0;
}

/**
 * The person changed a queued errand before it started: what it will start
 * with, and what they confirmed for it. Nothing when it already started.
 */
export async function updateQueuedBrowserRun(
  runId: string,
  input: Pick<
    Partial<BrowserRunInsert>,
    "paymentAllowed" | "pendingTask" | "submission"
  >
) {
  const rows = await db
    .update(browserRuns)
    .set({
      ...input,
      queueRevision: sql`${browserRuns.queueRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(browserRuns.id, runId),
        eq(browserRuns.status, "queued"),
        isNull(browserRuns.retriedAsRunId)
      )
    )
    .returning({ id: browserRuns.id });
  return rows.length > 0;
}

/**
 * Close a queued errand that will not start: the person cancelled it, it
 * waited too long, or Browser Use is out of credits. The row keeps its place
 * in history and, when the errand ended by itself, the report the person is
 * owed. Undefined when it had already started or been closed.
 */
export async function closeQueuedBrowserRun(
  runId: string,
  input: Pick<BrowserRunInsert, "outcome"> & {
    readonly status: "failed" | "stopped";
  }
) {
  const now = new Date();
  const [row] = await db
    .update(browserRuns)
    .set({
      ...input,
      completedAt: now,
      pendingTask: null,
      retryAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(browserRuns.id, runId),
        eq(browserRuns.status, "queued"),
        isNull(browserRuns.retriedAsRunId)
      )
    )
    .returning();
  return row;
}

/**
 * Keep the report a settled run owes its conversation. It stays pending until
 * a delivery lands, so an unreachable conversation delays the report instead
 * of losing it. The settler's lease on the plain report it claimed with is
 * given back here, so the full report goes out now — unless the plain one
 * was already sent while the settle took its time: that delivery keeps its
 * lease, and the person does not get the errand twice.
 */
export async function saveBrowserRunReport(runId: string, report: string) {
  await db
    .update(browserRuns)
    .set({
      report,
      reportClaimedAt: sql`case when ${browserRuns.reportAttempts} = 0 then null else ${browserRuns.reportClaimedAt} end`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(browserRuns.id, runId), isNull(browserRuns.reportDeliveredAt))
    );
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

/** Mark the report delivered; true when this call was the one that did. */
export async function finishBrowserRunReport(runId: string) {
  const now = new Date();
  const rows = await db
    .update(browserRuns)
    .set({ reportClaimedAt: null, reportDeliveredAt: now, updatedAt: now })
    .where(
      and(eq(browserRuns.id, runId), isNull(browserRuns.reportDeliveredAt))
    )
    .returning({ id: browserRuns.id });
  return rows.length > 0;
}

/** The wait after a failed delivery: 30 s, doubling, at most 15 minutes. */
const firstRedeliveryDelayMs = 30_000;
const maximumRedeliveryDelayMs = 15 * 60_000;

/**
 * A delivery failed: the report waits before the next try. The poller now
 * looks every few seconds, and a lease given straight back spent all ten
 * attempts in under a minute of a channel outage, after which the report
 * was never tried again. The wait is written as a lease that lapses then
 * (30 s after the first failure, doubling up to 15 minutes), so ten attempts
 * cover about an hour and a half.
 */
export async function releaseBrowserRunReport(runId: string) {
  const now = new Date();
  await db
    .update(browserRuns)
    .set({
      reportClaimedAt: sql`${now.toISOString()}::timestamptz - make_interval(secs => ${reportLeaseMs / 1000}) + make_interval(secs => least(${firstRedeliveryDelayMs / 1000} * power(2, greatest(${browserRuns.reportAttempts} - 1, 0)), ${maximumRedeliveryDelayMs / 1000}))`,
      updatedAt: now,
    })
    .where(
      and(eq(browserRuns.id, runId), isNull(browserRuns.reportDeliveredAt))
    );
}

/**
 * How long a report the conversation accepted may wait for its turn. With
 * `turnPolicy: "queue"` it waits behind a turn the person started, which can
 * run for minutes; sent again after the plain lease, both copies ran. It
 * stays flat: every hand-over counts in `reportAttempts`, which is also what
 * `reopenBrowserRunReport` gives up on, and a hold that grew from a minute
 * spent three attempts behind one long turn of the person's — eve runs the
 * queued copies as one report turn, and a single failure of that turn then
 * dropped the report for good.
 */
const handedOverLeaseMs = 10 * 60_000;

/**
 * The conversation accepted the report and its turn is queued: nobody sends
 * it again until that turn had time to start. Its start renews the lease
 * (`renewBrowserRunReportLease`), and its end settles the report.
 */
export async function holdBrowserRunReportForTurn(runId: string) {
  const now = new Date();
  await db
    .update(browserRuns)
    .set({
      reportClaimedAt: new Date(
        now.getTime() + handedOverLeaseMs - reportLeaseMs
      ),
      updatedAt: now,
    })
    .where(
      and(eq(browserRuns.id, runId), isNull(browserRuns.reportDeliveredAt))
    );
}

/**
 * The conversation took the report and a turn is working on it: the lease
 * starts over, so a report turn that runs a while is not sent a second time.
 */
export async function renewBrowserRunReportLease(runId: string) {
  const now = new Date();
  await db
    .update(browserRuns)
    .set({ reportClaimedAt: now, updatedAt: now })
    .where(
      and(
        eq(browserRuns.id, runId),
        isNotNull(browserRuns.report),
        isNull(browserRuns.reportDeliveredAt)
      )
    );
}

/** Whether a run's report already reached its conversation. */
export async function browserRunReportDelivered(runId: string) {
  const [row] = await db
    .select({ deliveredAt: browserRuns.reportDeliveredAt })
    .from(browserRuns)
    .where(eq(browserRuns.id, runId))
    .limit(1);
  return row?.deliveredAt instanceof Date;
}

/** Report turns that fail before reaching the person are retried this often. */
const maximumFailedReportTurns = 3;

/**
 * The report turn failed before anything reached the person — the model
 * came back empty, the provider failed. The report goes back in line for the
 * next poll, a few times; after that it stays undelivered, where the overdue
 * watch tells the owner and `browser_task status` hands it over.
 */
export async function reopenBrowserRunReport(runId: string) {
  const now = new Date();
  const [row] = await db
    .update(browserRuns)
    .set({
      reportAttempts: sql`case when ${browserRuns.reportAttempts} >= ${maximumFailedReportTurns} then ${maximumReportAttempts} else ${browserRuns.reportAttempts} end`,
      reportClaimedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(browserRuns.id, runId),
        isNotNull(browserRuns.report),
        isNull(browserRuns.reportDeliveredAt)
      )
    )
    .returning({ reportAttempts: browserRuns.reportAttempts });
  return row && { retried: row.reportAttempts < maximumReportAttempts };
}

/**
 * Reports of settled runs that have not reached their conversation although
 * the run ended more than `settledBefore` ago — each one is a person who
 * thinks their errand is still going. Waiting for a code or a decision
 * counts: those are the reports that must land within the minute. At most
 * 50 are listed, oldest first; `total` on each counts all of them.
 */
export async function listOverdueBrowserRunReports(
  settledBefore: Date,
  now = new Date()
) {
  return db
    .select({
      completedAt: browserRuns.completedAt,
      conversationChannel: browserRuns.conversationChannel,
      id: browserRuns.id,
      reportAttempts: browserRuns.reportAttempts,
      // A window count is taken before the limit applies.
      total: sql<number>`(count(*) over ())::int`,
    })
    .from(browserRuns)
    .where(
      and(
        isNotNull(browserRuns.report),
        isNull(browserRuns.reportDeliveredAt),
        lt(browserRuns.completedAt, settledBefore),
        gt(
          browserRuns.completedAt,
          new Date(now.getTime() - reportRetryWindowMs)
        )
      )
    )
    .orderBy(asc(browserRuns.completedAt))
    .limit(50);
}

export async function listPendingBrowserRunReports(limit: number) {
  return db
    .select({ id: browserRuns.id })
    .from(browserRuns)
    .where(reportPending(new Date()))
    .orderBy(asc(browserRuns.completedAt))
    .limit(limit);
}

/**
 * Whether anything is still in flight for the poller to watch: a run Browser
 * Use is still working on, or a report waiting to be sent again.
 */
export async function hasLiveBrowserRuns() {
  const now = new Date();
  const [row] = await db
    .select({ id: browserRuns.id })
    .from(browserRuns)
    .where(
      or(
        and(
          isNull(browserRuns.completedAt),
          inArray(browserRuns.status, activeBrowserRunStatuses)
        ),
        reportPending(now)
      )
    )
    .limit(1);
  return row !== undefined;
}

/** The runs still open in one Browser Use session, newest first. */
export async function listOpenBrowserRunIdsInSession(sessionId: string) {
  const rows = await db
    .select({ id: browserRuns.id })
    .from(browserRuns)
    .where(
      and(
        eq(browserRuns.sessionId, sessionId),
        isNull(browserRuns.completedAt),
        inArray(browserRuns.status, activeBrowserRunStatuses)
      )
    )
    .orderBy(desc(browserRuns.createdAt))
    .limit(5);
  return rows.map((row) => row.id);
}

/**
 * How long a page left open for the person — a code, an approval in their
 * app, 3-D Secure, a manual sign-in — is kept before Bro stops its browser
 * itself. The cloud ends an idle browser about twenty minutes after its last
 * run, and a browser it ends loses what changed in it; stopped by Bro, it
 * writes its cookies to the profile. A code has expired by then anyway.
 */
const idleBrowserCloseMs = 15 * 60_000;
/** Past this the cloud has stopped the browser itself, whatever Bro did. */
const browserLifetimeMs = 4 * 60 * 60_000;
/** A settled run's browser is gone this long after it, stopped or not. */
const settledBrowserWindowMs = 30 * 60_000;
/** An open run is expired by the poller before this. */
const workingBrowserWindowMs = 60 * 60_000;

/**
 * The runs that may still hold a live browser on the workspace profile: one
 * Browser Use is working on, or one settled with its page kept for the
 * person and not yet released. A queued errand has no browser yet.
 */
function holdsBrowser(now: Date) {
  return and(
    isNull(browserRuns.browserReleasedAt),
    isNull(browserRuns.retriedAsRunId),
    sql`${browserRuns.id} NOT LIKE 'queued:%'`,
    or(
      and(
        isNull(browserRuns.completedAt),
        inArray(browserRuns.status, activeBrowserRunStatuses),
        gt(
          browserRuns.createdAt,
          new Date(now.getTime() - workingBrowserWindowMs)
        )
      ),
      gt(
        browserRuns.completedAt,
        new Date(now.getTime() - settledBrowserWindowMs)
      )
    )
  );
}

/** The workspace's runs that may still hold a browser, and on which site. */
export async function listBrowserHoldingRuns(
  workspaceId: string,
  now = new Date()
) {
  return db
    .select({
      completedAt: browserRuns.completedAt,
      id: browserRuns.id,
      outcome: browserRuns.outcome,
      sessionId: browserRuns.sessionId,
      site: browserRuns.site,
    })
    .from(browserRuns)
    .where(and(eq(browserRuns.workspaceId, workspaceId), holdsBrowser(now)))
    .limit(20);
}

/**
 * The workspaces with a run that may still hold a browser, among `ids`: a
 * keep-alive visit on the same profile then waits, since whichever browser
 * stops last is what the profile keeps.
 */
export async function listWorkspacesHoldingBrowsers(
  workspaceIds: readonly string[],
  now = new Date()
) {
  if (workspaceIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ workspaceId: browserRuns.workspaceId })
    .from(browserRuns)
    .where(
      and(
        inArray(browserRuns.workspaceId, [...workspaceIds]),
        holdsBrowser(now)
      )
    );
  return rows.map((row) => row.workspaceId);
}

/**
 * Take the page a settled run left, for whoever comes first: a follow-up
 * that is about to type a code into it or run in it, the poller's idle stop,
 * or the stop at settle. The mark is `browser_released_at`, set only while it
 * is empty, so exactly one of them gets the page and the others leave it
 * alone. True when this call took it.
 */
export async function claimBrowserRunBrowser(runId: string, now = new Date()) {
  const rows = await db
    .update(browserRuns)
    .set({ browserReleasedAt: now, updatedAt: now })
    .where(
      and(eq(browserRuns.id, runId), isNull(browserRuns.browserReleasedAt))
    )
    .returning({ id: browserRuns.id });
  return rows.length > 0;
}

/**
 * Give the page back when the one who took it could not use it: the stop
 * did not happen, or the follow-up did not start. Only the claim made at
 * `claimedAt` is undone, never a later one.
 */
export async function unclaimBrowserRunBrowser(runId: string, claimedAt: Date) {
  await db
    .update(browserRuns)
    .set({ browserReleasedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(browserRuns.id, runId),
        eq(browserRuns.browserReleasedAt, claimedAt)
      )
    );
}

/**
 * The run no longer holds a live browser: Bro stopped it, a follow-up took
 * it over, or it is gone. Its live view is dead with it, so it is cleared:
 * a follow-up must not inherit it, and a report must not hand it out. A
 * claim already on the row stays as the moment it was released.
 */
export async function releaseBrowserRunBrowser(
  runId: string,
  now = new Date()
) {
  await db
    .update(browserRuns)
    .set({
      browserReleasedAt: sql`coalesce(${browserRuns.browserReleasedAt}, ${now.toISOString()}::timestamptz)`,
      liveViewUrl: null,
      updatedAt: now,
    })
    .where(eq(browserRuns.id, runId));
}

/**
 * Whether another run of the workspace may still hold a browser on its
 * profile. The idle stop waits for it a little: if the cloud keeps only the
 * cookies of the browser that stops last, this one stopping last is what
 * keeps its sign-in.
 */
export async function otherRunHoldsBrowser(
  workspaceId: string,
  runId: string,
  now = new Date()
) {
  const rows = await db
    .select({ id: browserRuns.id })
    .from(browserRuns)
    .where(
      and(
        eq(browserRuns.workspaceId, workspaceId),
        ne(browserRuns.id, runId),
        holdsBrowser(now)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether anything of the workspace may still use its browser profile: a
 * browser up, an errand waiting in the queue, or one parked for a retry
 * after an anti-bot wall. Forgetting the profile waits for them.
 */
export async function workspaceUsesBrowserProfile(
  workspaceId: string,
  now = new Date()
) {
  if ((await listBrowserHoldingRuns(workspaceId, now)).length > 0) {
    return true;
  }
  const waiting = await db
    .select({ id: browserRuns.id })
    .from(browserRuns)
    .where(
      and(
        eq(browserRuns.workspaceId, workspaceId),
        isNull(browserRuns.retriedAsRunId),
        or(
          eq(browserRuns.status, "queued"),
          and(eq(browserRuns.status, "waiting"), isNotNull(browserRuns.retryAt))
        )
      )
    )
    .limit(1);
  return waiting.length > 0;
}

/**
 * Forget the workspace's browser profile: the next errand creates a new,
 * empty one. Returns the id that was forgotten, for Browser Use to delete.
 */
export async function forgetBrowserProfile(workspaceId: string) {
  const rows = await db
    .delete(browserProfiles)
    .where(eq(browserProfiles.workspaceId, workspaceId))
    .returning({ profileId: browserProfiles.profileId });
  return rows[0]?.profileId;
}

function idleBrowser(now: Date) {
  return and(
    isNull(browserRuns.browserReleasedAt),
    isNotNull(browserRuns.sessionId),
    sql`${browserRuns.id} NOT LIKE 'queued:%'`,
    lte(browserRuns.completedAt, new Date(now.getTime() - idleBrowserCloseMs)),
    gt(browserRuns.completedAt, new Date(now.getTime() - browserLifetimeMs))
  );
}

/**
 * Take the settled runs whose page was kept for the person and has sat idle
 * long enough to be stopped by Bro before the cloud ends it, the ones looked
 * at longest ago first. Taking one claims its page (`claimBrowserRunBrowser`
 * with `now`), so a follow-up arriving meanwhile does not type into a page
 * being stopped; one whose stop does not happen is given back and goes to the
 * back of the line.
 */
export async function takeIdleBrowserRuns(now: Date, limit: number) {
  const next = db
    .select({ id: browserRuns.id })
    .from(browserRuns)
    .where(idleBrowser(now))
    .orderBy(asc(browserRuns.updatedAt))
    .limit(limit);
  return db
    .update(browserRuns)
    .set({ browserReleasedAt: now, updatedAt: now })
    .where(and(inArray(browserRuns.id, next), idleBrowser(now)))
    .returning({
      completedAt: browserRuns.completedAt,
      id: browserRuns.id,
      sessionId: browserRuns.sessionId,
      workspaceId: browserRuns.workspaceId,
    });
}

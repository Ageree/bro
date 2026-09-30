import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  browserRuns,
  browserVmRuns,
  browserVms,
  db,
  settledBrowserVmRunStatuses,
} from "@db";

type BrowserVmInsert = typeof browserVms.$inferInsert;
type BrowserVmRunInsert = typeof browserVmRuns.$inferInsert;

/** A browser errand's statuses before it settles, queued ones included. */
const openBrowserRunStatuses = [
  "created",
  "queued",
  "running",
  "waiting",
] as const satisfies readonly (typeof browserRuns.$inferSelect)["status"][];

/** The states of a VM on its way up or down: the reconcile follows each. */
const movingStates = [
  "creating",
  "starting",
  "stopping",
  "deleting",
] as const satisfies readonly BrowserVmInsert["state"][];

/**
 * A task line names one errand for a day at most: a run found by it after
 * that is an older errand that happened to say the same thing.
 */
const taskLineWindowMs = 24 * 60 * 60_000;

function leaseFree(now: Date) {
  return or(isNull(browserVms.leaseUntil), lte(browserVms.leaseUntil, now));
}

function unusedSince(moment: Date) {
  return or(isNull(browserVms.lastUsedAt), lte(browserVms.lastUsedAt, moment));
}

/** The workspace's VM record, or undefined when it never used the VM. */
export async function readBrowserVm(workspaceId: string) {
  const rows = await db
    .select()
    .from(browserVms)
    .where(eq(browserVms.workspaceId, workspaceId))
    .limit(1);
  return rows[0];
}

/**
 * The workspace's VM record, created as `stopped` with no VM when it has
 * none: that is how a workspace without a VM reads, and the first errand
 * creates the VM from it. A concurrent caller's record wins.
 */
export async function ensureBrowserVmRecord(workspaceId: string) {
  await db
    .insert(browserVms)
    .values({ state: "stopped", workspaceId })
    .onConflictDoNothing({ target: browserVms.workspaceId });
  const row = await readBrowserVm(workspaceId);
  if (!row) throw new Error("The browser VM record could not be created.");
  return row;
}

/**
 * Claim the right to create, power or delete the workspace's VM for
 * `leaseMs`. Only one caller holds it: an errand, the poller's reconcile and
 * a deletion may all reach for the VM at once, and two creations would
 * leave a billed VM nobody knows of. The row as claimed, or undefined when
 * someone else holds a live lease (or there is no record).
 */
export async function claimBrowserVmLease(
  workspaceId: string,
  now: Date,
  leaseMs: number
) {
  const [row] = await db
    .update(browserVms)
    .set({ claimedAt: now, leaseUntil: new Date(now.getTime() + leaseMs) })
    .where(and(eq(browserVms.workspaceId, workspaceId), leaseFree(now)))
    .returning();
  return row;
}

/**
 * Give the lease back once the step is done. With `leaseUntil` (the claimed
 * row's own) only that claim is released: a caller that outlived its lease
 * must not free the one another caller took since.
 */
export async function releaseBrowserVmLease(
  workspaceId: string,
  leaseUntil?: Date
) {
  await db
    .update(browserVms)
    .set({ leaseUntil: null })
    .where(
      and(
        eq(browserVms.workspaceId, workspaceId),
        leaseUntil === undefined
          ? undefined
          : eq(browserVms.leaseUntil, leaseUntil)
      )
    );
}

/**
 * Write any of the record's columns. A patch that moves the VM to another
 * state restamps `state_changed_at` with `now`, since the watchdog measures
 * how long a VM sits in one state; writing the state it already has keeps
 * the old stamp. With `leaseUntil` (the claimed row's own) the write is a
 * lease holder's and lands only while no other caller took the lease since:
 * a step that outlived its lease must not overwrite what the new holder did,
 * and throws before it acts on what it read.
 */
export async function updateBrowserVm(
  workspaceId: string,
  patch: Partial<
    Omit<
      BrowserVmInsert,
      "createdAt" | "stateChangedAt" | "updatedAt" | "workspaceId"
    >
  >,
  now = new Date(),
  leaseUntil?: Date
) {
  const nextState = patch.state ?? null;
  const [row] = await db
    .update(browserVms)
    .set({
      ...patch,
      stateChangedAt: sql`CASE WHEN ${nextState}::text IS NULL OR ${nextState}::text = ${browserVms.state} THEN ${browserVms.stateChangedAt} ELSE ${now.toISOString()}::timestamptz END`,
      updatedAt: now,
    })
    .where(
      and(
        eq(browserVms.workspaceId, workspaceId),
        leaseUntil === undefined
          ? undefined
          : eq(browserVms.leaseUntil, leaseUntil)
      )
    )
    .returning();
  if (row) return row;
  throw new Error(
    leaseUntil === undefined
      ? "The browser VM record is gone."
      : "The browser VM record is gone, or another step took its lease."
  );
}

/**
 * Put the VM back on the person's idle window: a person's errand keeps it
 * `BROWSER_VM_IDLE_MINUTES` after its last use, whatever an earlier errand
 * set. Nothing when the workspace has no VM record.
 */
export async function clearBrowserVmStopNotBefore(
  workspaceId: string,
  now = new Date()
) {
  await db
    .update(browserVms)
    .set({ stopNotBefore: null, updatedAt: now })
    .where(
      and(
        eq(browserVms.workspaceId, workspaceId),
        isNotNull(browserVms.stopNotBefore)
      )
    );
}

/**
 * A person's errand older than this no longer holds a VM on the person's
 * window: a row stuck open would otherwise do so for good.
 */
const personErrandWindowMs = 6 * 60 * 60_000;

/**
 * Keep the VM up at least until `until`, never shortening what is set. A VM
 * on the person's idle window has that window's end (its last use plus
 * `personIdleMs`) written down first, so an errand nobody waits for does not
 * cut short what a person's errand is owed — and it is not written down at
 * all while a person's errand is under way or queued on the workspace: that
 * errand keeps using the VM, and its window moves with it. With `onlyIfSet`,
 * a VM on the person's window is left on it. One statement, so two callers
 * at once both count.
 */
export async function extendBrowserVmStopNotBefore(
  workspaceId: string,
  input: {
    readonly onlyIfSet?: boolean;
    readonly personIdleMs: number;
    readonly until: Date;
  },
  now = new Date()
) {
  const personErrandOpen = db
    .select({ id: browserRuns.id })
    .from(browserRuns)
    .where(
      and(
        eq(browserRuns.workspaceId, workspaceId),
        // Runs from before the flag count as the person's.
        or(
          isNull(browserRuns.startedByPerson),
          eq(browserRuns.startedByPerson, true)
        ),
        inArray(browserRuns.status, [...openBrowserRunStatuses]),
        gt(
          browserRuns.createdAt,
          new Date(now.getTime() - personErrandWindowMs)
        )
      )
    );
  await db
    .update(browserVms)
    .set({
      stopNotBefore: sql`greatest(coalesce(${browserVms.stopNotBefore}, ${browserVms.lastUsedAt} + make_interval(secs => ${input.personIdleMs / 1000})), ${input.until.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(
      and(
        eq(browserVms.workspaceId, workspaceId),
        input.onlyIfSet === true
          ? isNotNull(browserVms.stopNotBefore)
          : or(isNotNull(browserVms.stopNotBefore), notExists(personErrandOpen))
      )
    );
}

/**
 * The VM records the poller's reconcile should look at this minute, skipping
 * any whose lease an errand or a deletion holds. They come round in turn,
 * the one whose lease was taken longest ago first (then the one longest in
 * its state), so records the reconcile can do nothing about — a failed VM
 * Cloud.ru keeps in `error`, say — do not fill the limit every minute. VMs
 * on their way up or down come first, with a limit of their own, so VMs
 * that are up never crowd them out. Of the settled ones only those with
 * something to do are listed: a ready VM whose idle stop may be due or with
 * a forgotten profile to wipe, a failed one that may still be running, and
 * a stopped one whose profile the person asked to forget, unless it was
 * given up on: only an errand starts that one again. The idle stop may be
 * due on the person's window (no `stop_not_before`) for a VM unused since
 * `idleBefore`, and otherwise once `stop_not_before` passed with the VM
 * unused since `graceBefore` (`agent/lib/browser-vm/idle.ts`).
 */
export async function listBrowserVmsToReconcile(
  now: Date,
  unused: { readonly graceBefore: Date; readonly idleBefore: Date },
  limit: number
) {
  const inTurn = [
    sql`${browserVms.claimedAt} ASC NULLS FIRST`,
    asc(browserVms.stateChangedAt),
  ];
  const [moving, settled] = await Promise.all([
    db
      .select()
      .from(browserVms)
      .where(and(inArray(browserVms.state, movingStates), leaseFree(now)))
      .orderBy(...inTurn)
      .limit(limit),
    db
      .select()
      .from(browserVms)
      .where(
        and(
          leaseFree(now),
          or(
            and(
              eq(browserVms.state, "ready"),
              or(
                eq(browserVms.profileResetPending, true),
                and(
                  isNull(browserVms.stopNotBefore),
                  unusedSince(unused.idleBefore)
                ),
                and(
                  lte(browserVms.stopNotBefore, now),
                  unusedSince(unused.graceBefore)
                )
              )
            ),
            and(eq(browserVms.state, "failed"), isNotNull(browserVms.vmId)),
            and(
              eq(browserVms.state, "stopped"),
              isNotNull(browserVms.vmId),
              eq(browserVms.profileResetPending, true),
              isNull(browserVms.givenUpAt)
            )
          )
        )
      )
      .orderBy(...inTurn)
      .limit(limit),
  ]);
  return [...moving, ...settled];
}

/**
 * Clear the pending profile wipe once the wipe of `profileGeneration` is
 * done. A forget that came in while the wipe ran moved the generation on,
 * so its flag stays and its own wipe is not lost. Whether it was cleared.
 */
export async function clearBrowserVmProfileReset(
  workspaceId: string,
  profileGeneration: number,
  now = new Date()
) {
  const [row] = await db
    .update(browserVms)
    .set({ profileResetPending: false, updatedAt: now })
    .where(
      and(
        eq(browserVms.workspaceId, workspaceId),
        eq(browserVms.profileResetPending, true),
        eq(browserVms.profileGeneration, profileGeneration)
      )
    )
    .returning({ workspaceId: browserVms.workspaceId });
  return row !== undefined;
}

/**
 * Remove the workspace's VM record once the VM itself is deleted, and the
 * runs recorded on it: their task text is the person's errand, and nothing
 * can read those runs back without the VM.
 */
export async function deleteBrowserVmRecord(workspaceId: string) {
  await db
    .delete(browserVmRuns)
    .where(eq(browserVmRuns.workspaceId, workspaceId));
  await db.delete(browserVms).where(eq(browserVms.workspaceId, workspaceId));
}

/**
 * Record a run before the worker is asked to start it, so a dispatch lost
 * on the network still has a row to find it by, and the composed task
 * outlives the VM. Recording the same id again changes nothing.
 */
export async function recordBrowserVmRun(
  input: Pick<
    BrowserVmRunInsert,
    "id" | "sessionId" | "status" | "task" | "workspaceId"
  >
) {
  await db
    .insert(browserVmRuns)
    .values(input)
    .onConflictDoNothing({ target: browserVmRuns.id });
}

export async function readBrowserVmRun(id: string) {
  const rows = await db
    .select()
    .from(browserVmRuns)
    .where(eq(browserVmRuns.id, id))
    .limit(1);
  return rows[0];
}

/**
 * Mirror what the worker, or the VM's absence, says about a run. A settled
 * run never reopens: a read that raced the settle and carries an older,
 * open status leaves the row alone and returns undefined, as does an
 * unknown id.
 */
export async function updateBrowserVmRun(
  id: string,
  patch: Partial<
    Omit<BrowserVmRunInsert, "createdAt" | "id" | "updatedAt" | "workspaceId">
  >,
  now = new Date()
) {
  const reopens = patch.status !== undefined && !isSettledStatus(patch.status);
  const [row] = await db
    .update(browserVmRuns)
    .set({ ...patch, updatedAt: now })
    .where(
      and(
        eq(browserVmRuns.id, id),
        reopens
          ? notInArray(browserVmRuns.status, [...settledBrowserVmRunStatuses])
          : undefined
      )
    )
    .returning();
  return row;
}

function isSettledStatus(status: NonNullable<BrowserVmRunInsert["status"]>) {
  return settledBrowserVmRunStatuses.some((settled) => settled === status);
}

/**
 * The newest run of the workspace from the last day, not cancelled, whose
 * task carries `line` as one whole line: the errand id and attempt line a
 * queued start or a background retry writes, so a start whose answer was
 * lost is adopted instead of started twice. `position` narrows the rows in
 * SQL; the whole-line match is exact here.
 */
export async function findBrowserVmRunByTaskLine(
  workspaceId: string,
  line: string,
  now = new Date()
) {
  const rows = await db
    .select()
    .from(browserVmRuns)
    .where(
      and(
        eq(browserVmRuns.workspaceId, workspaceId),
        ne(browserVmRuns.status, "cancelled"),
        gt(browserVmRuns.createdAt, new Date(now.getTime() - taskLineWindowMs)),
        sql`position(${line} in ${browserVmRuns.task}) > 0`
      )
    )
    .orderBy(desc(browserVmRuns.createdAt))
    .limit(20);
  return rows.find((row) => row.task.split("\n").includes(line));
}

/** The workspace's runs that have not settled, newest first. */
export async function listOpenBrowserVmRuns(workspaceId: string) {
  return db
    .select()
    .from(browserVmRuns)
    .where(
      and(
        eq(browserVmRuns.workspaceId, workspaceId),
        notInArray(browserVmRuns.status, [...settledBrowserVmRunStatuses])
      )
    )
    .orderBy(desc(browserVmRuns.createdAt));
}

/**
 * The workspace's runs that were going at some point between `from` and
 * `to`, oldest first: the errands a stretch of the VM's powered-on time
 * served, which that stretch is shared between.
 */
export async function listBrowserVmRunIdsBetween(
  workspaceId: string,
  from: Date,
  to: Date
) {
  const rows = await db
    .select({ id: browserVmRuns.id })
    .from(browserVmRuns)
    .where(
      and(
        eq(browserVmRuns.workspaceId, workspaceId),
        lte(browserVmRuns.createdAt, to),
        or(isNull(browserVmRuns.finishedAt), gt(browserVmRuns.finishedAt, from))
      )
    )
    .orderBy(asc(browserVmRuns.createdAt));
  return rows.map((row) => row.id);
}

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AccessScope } from "@shared/identity/access-scope";
import type { BrowserCapability } from "@shared/browser/autonomy";
import type { BrowserVerificationPlan } from "@shared/browser/verification";
import { browserProfiles, browserRuns, db } from "@db";
import { ensureScope } from "./scope";

type BrowserRunInsert = typeof browserRuns.$inferInsert;

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
      activeRunId: input.activeRunId ?? input.id,
      createdByUserId: scope.userId,
      rootRunId: input.rootRunId ?? input.id,
      workspaceId: scope.workspaceId,
    })
    .returning();
  if (!row) throw new Error("The browser run could not be recorded.");
  return row;
}

export async function resolveBrowserRunForScope(
  scope: AccessScope,
  runId: string
) {
  const requested = await readBrowserRunForScope(scope, runId);
  if (!requested) return undefined;
  const rootId = requested.rootRunId ?? requested.id;
  const root =
    rootId === requested.id
      ? requested
      : await readBrowserRunForScope(scope, rootId);
  if (!root) return undefined;
  const activeId = root.activeRunId ?? root.id;
  const active =
    activeId === root.id
      ? root
      : activeId === requested.id
        ? requested
        : await readBrowserRunForScope(scope, activeId);
  return { active: active ?? root, requested, root };
}

async function readBrowserRunForScope(scope: AccessScope, runId: string) {
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

/** Settle only the current lineage head. Old callbacks become harmless. */
export async function claimBrowserLineageSettlement(
  options: {
    readonly lineageRevision: number;
    readonly rootRunId: string;
    readonly runId: string;
  },
  input: Pick<
    BrowserRunInsert,
    | "finalNeed"
    | "finalTaskStatus"
    | "outcome"
    | "status"
    | "verificationReport"
  >
) {
  const completedAt = new Date();
  const [root] = await db
    .update(browserRuns)
    .set({
      ...input,
      completedAt,
      repairState: "none",
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(browserRuns.id, options.rootRunId),
        eq(browserRuns.activeRunId, options.runId),
        eq(browserRuns.lineageRevision, options.lineageRevision),
        eq(browserRuns.lineageState, "active"),
        isNull(browserRuns.completedAt)
      )
    )
    .returning();
  if (!root) return undefined;
  if (options.runId !== options.rootRunId) {
    await db
      .update(browserRuns)
      .set({ ...input, completedAt, updatedAt: completedAt })
      .where(eq(browserRuns.id, options.runId));
  }
  return root;
}

export async function cancelBrowserLineage(
  rootRunId: string,
  expectedRevision: number
) {
  const now = new Date();
  const [row] = await db
    .update(browserRuns)
    .set({
      completedAt: now,
      deliveryState: "pending",
      finalNeed: "none",
      finalTaskStatus: "blocked",
      lineageToken: null,
      lineageRevision: sql`${browserRuns.lineageRevision} + 1`,
      lineageState: "cancelled",
      outcome:
        "Cancellation was requested; provider acknowledgement is pending.",
      status: "stopped",
      updatedAt: now,
    })
    .where(
      and(
        eq(browserRuns.id, rootRunId),
        eq(browserRuns.lineageRevision, expectedRevision),
        isNull(browserRuns.completedAt)
      )
    )
    .returning();
  return row;
}

export async function recordBrowserLineageCancellationResult(options: {
  readonly confirmed: boolean;
  readonly lineageRevision: number;
  readonly rootRunId: string;
}) {
  const [row] = await db
    .update(browserRuns)
    .set({
      outcome: options.confirmed
        ? "The browser run was cancelled and the provider confirmed the stop."
        : "The browser run was cancelled logically, but the provider stop is unconfirmed.",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(browserRuns.id, options.rootRunId),
        eq(browserRuns.lineageRevision, options.lineageRevision),
        eq(browserRuns.lineageState, "cancelled")
      )
    )
    .returning();
  return row;
}

export async function claimBrowserLineageTransition(options: {
  readonly activeRunId: string;
  readonly allowCompleted?: boolean;
  readonly allowSupersede?: boolean;
  readonly capability: BrowserCapability;
  readonly expectedRevision: number;
  readonly rootRunId: string;
  readonly task: string;
  readonly verificationPlan: BrowserVerificationPlan | null;
}) {
  const token = randomUUID();
  const marker = `pending:${token}`;
  const markedTask = `${options.task}\n\n[BRO_TRANSITION:${token}]`;
  const [root] = await db
    .update(browserRuns)
    .set({
      activeRunId: marker,
      capability: options.capability,
      completedAt: null,
      deliveryClaimedAt: null,
      deliveryState: "pending",
      deliveryToken: null,
      deliveredAt: null,
      finalNeed: null,
      finalTaskStatus: null,
      lineagePreviousRunId: sql`${browserRuns.activeRunId}`,
      lineageRecoveryClaimedAt: null,
      lineageRecoveryToken: null,
      lineageRevision: sql`${browserRuns.lineageRevision} + 1`,
      lineageState: "claimed",
      lineageTask: markedTask,
      lineageToken: token,
      outcome: null,
      repairClaimedAt: null,
      repairDeadline: null,
      repairState: "none",
      repairToken: null,
      status: "created",
      updatedAt: new Date(),
      verificationReport: null,
      verificationPlan: options.verificationPlan,
    })
    .where(
      and(
        eq(browserRuns.id, options.rootRunId),
        eq(browserRuns.lineageRevision, options.expectedRevision),
        options.allowCompleted ? undefined : isNull(browserRuns.completedAt),
        options.allowSupersede
          ? or(
              and(
                eq(browserRuns.activeRunId, options.activeRunId),
                eq(browserRuns.lineageState, "active")
              ),
              inArray(browserRuns.lineageState, [
                "claimed",
                "creating",
                "recovering",
              ])
            )
          : and(
              eq(browserRuns.activeRunId, options.activeRunId),
              eq(browserRuns.lineageState, "active")
            )
      )
    )
    .returning();
  return root ? { marker, root, task: markedTask, token } : undefined;
}

export async function markBrowserLineageCreating(
  rootRunId: string,
  token: string,
  lineageRevision: number
) {
  const [row] = await db
    .update(browserRuns)
    .set({ lineageState: "creating", updatedAt: new Date() })
    .where(
      and(
        eq(browserRuns.id, rootRunId),
        eq(browserRuns.lineageToken, token),
        eq(browserRuns.lineageRevision, lineageRevision),
        isNull(browserRuns.completedAt),
        eq(browserRuns.lineageState, "claimed")
      )
    )
    .returning();
  return row;
}

export async function prepareBrowserLineageTask(options: {
  readonly lineageRevision: number;
  readonly rootRunId: string;
  readonly task: string;
  readonly token: string;
}) {
  const task = `${options.task}\n\n[BRO_TRANSITION:${options.token}]`;
  const [row] = await db
    .update(browserRuns)
    .set({ lineageTask: task, updatedAt: new Date() })
    .where(
      and(
        eq(browserRuns.id, options.rootRunId),
        eq(browserRuns.lineageToken, options.token),
        eq(browserRuns.lineageRevision, options.lineageRevision),
        eq(browserRuns.lineageState, "claimed"),
        isNull(browserRuns.completedAt)
      )
    )
    .returning();
  return row ? { row, task } : undefined;
}

export async function finishBrowserLineageTransition(options: {
  readonly capability?: BrowserCapability;
  readonly childId: string;
  readonly rootRunId: string;
  readonly lineageRevision: number;
  readonly recoveryToken?: string;
  readonly sessionId?: string;
  readonly token: string;
  readonly verificationPlan?: BrowserVerificationPlan | null;
}) {
  const [row] = await db
    .update(browserRuns)
    .set({
      activeRunId: options.childId,
      capability: options.capability,
      lineageState: "active",
      repairState: sql`CASE WHEN ${browserRuns.repairToken} = ${options.token} THEN 'running' ELSE ${browserRuns.repairState} END`,
      sessionId: options.sessionId,
      updatedAt: new Date(),
      verificationPlan: options.verificationPlan,
    })
    .where(
      and(
        eq(browserRuns.id, options.rootRunId),
        eq(browserRuns.lineageToken, options.token),
        eq(browserRuns.lineageRevision, options.lineageRevision),
        isNull(browserRuns.completedAt),
        options.recoveryToken
          ? and(
              eq(browserRuns.lineageState, "recovering"),
              eq(browserRuns.lineageRecoveryToken, options.recoveryToken)
            )
          : eq(browserRuns.lineageState, "creating")
      )
    )
    .returning();
  return row;
}

export async function failBrowserLineageTransition(
  rootRunId: string,
  token: string,
  lineageRevision: number,
  recoveryToken?: string
) {
  const [row] = await db
    .update(browserRuns)
    .set({
      activeRunId: sql`${browserRuns.lineagePreviousRunId}`,
      lineageState: "active",
      repairState: sql`CASE WHEN ${browserRuns.repairToken} = ${token} THEN 'failed' ELSE ${browserRuns.repairState} END`,
      status: "running",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(browserRuns.id, rootRunId),
        eq(browserRuns.lineageToken, token),
        eq(browserRuns.lineageRevision, lineageRevision),
        isNull(browserRuns.completedAt),
        recoveryToken
          ? and(
              eq(browserRuns.lineageState, "recovering"),
              eq(browserRuns.lineageRecoveryToken, recoveryToken)
            )
          : inArray(browserRuns.lineageState, ["claimed", "creating"])
      )
    )
    .returning();
  return row;
}

export async function claimBrowserRepair(options: {
  readonly activeRunId: string;
  readonly deadline: Date;
  readonly expectedRevision: number;
  readonly rootRunId: string;
  readonly task: string;
}) {
  const token = randomUUID();
  const marker = `pending:${token}`;
  const markedTask = `[BRO_REPAIR:${token}]\n${options.task}`;
  const [root] = await db
    .update(browserRuns)
    .set({
      activeRunId: marker,
      completedAt: null,
      deliveryClaimedAt: null,
      deliveryState: "pending",
      deliveryToken: null,
      deliveredAt: null,
      finalNeed: null,
      finalTaskStatus: null,
      lineagePreviousRunId: sql`${browserRuns.activeRunId}`,
      lineageRecoveryClaimedAt: null,
      lineageRecoveryToken: null,
      lineageRevision: sql`${browserRuns.lineageRevision} + 1`,
      lineageState: "claimed",
      lineageTask: markedTask,
      lineageToken: token,
      outcome: null,
      repairClaimedAt: new Date(),
      repairCount: sql`${browserRuns.repairCount} + 1`,
      repairDeadline: options.deadline,
      repairState: "claimed",
      repairTask: markedTask,
      repairToken: token,
      status: "created",
      updatedAt: new Date(),
      verificationReport: null,
    })
    .where(
      and(
        eq(browserRuns.id, options.rootRunId),
        eq(browserRuns.activeRunId, options.activeRunId),
        eq(browserRuns.lineageRevision, options.expectedRevision),
        eq(browserRuns.lineageState, "active"),
        eq(browserRuns.repairCount, 0),
        isNull(browserRuns.completedAt)
      )
    )
    .returning();
  return root ? { root, task: markedTask, token } : undefined;
}

export async function claimBrowserLineageRecovery(options: {
  readonly lineageRevision: number;
  readonly rootRunId: string;
  readonly staleBefore: Date;
  readonly token: string;
}) {
  const recoveryToken = randomUUID();
  const claimedAt = new Date();
  const [row] = await db
    .update(browserRuns)
    .set({
      lineageRecoveryClaimedAt: claimedAt,
      lineageRecoveryToken: recoveryToken,
      lineageState: "recovering",
      updatedAt: claimedAt,
    })
    .where(
      and(
        eq(browserRuns.id, options.rootRunId),
        eq(browserRuns.lineageToken, options.token),
        eq(browserRuns.lineageRevision, options.lineageRevision),
        or(
          eq(browserRuns.lineageState, "creating"),
          and(
            eq(browserRuns.lineageState, "recovering"),
            lt(browserRuns.lineageRecoveryClaimedAt, options.staleBefore)
          )
        ),
        isNull(browserRuns.completedAt)
      )
    )
    .returning();
  return row ? { recoveryToken, row } : undefined;
}

export async function claimBrowserRunDelivery(options: {
  readonly activeRunId: string;
  readonly lineageRevision: number;
  readonly rootRunId: string;
}) {
  const token = randomUUID();
  const claimedAt = new Date();
  const [row] = await db
    .update(browserRuns)
    .set({
      deliveryClaimedAt: claimedAt,
      deliveryState: "claimed",
      deliveryToken: token,
      updatedAt: claimedAt,
    })
    .where(
      and(
        eq(browserRuns.id, options.rootRunId),
        eq(browserRuns.activeRunId, options.activeRunId),
        eq(browserRuns.lineageRevision, options.lineageRevision),
        eq(browserRuns.deliveryState, "pending"),
        isNotNull(browserRuns.completedAt)
      )
    )
    .returning();
  return row ? { row, token } : undefined;
}

export async function acknowledgeBrowserRunDelivery(
  runId: string,
  token: string,
  lineageRevision: number
) {
  const now = new Date();
  const [row] = await db
    .update(browserRuns)
    .set({ deliveryState: "acked", deliveredAt: now, updatedAt: now })
    .where(
      and(
        eq(browserRuns.id, runId),
        eq(browserRuns.deliveryToken, token),
        eq(browserRuns.lineageRevision, lineageRevision),
        eq(browserRuns.deliveryState, "claimed")
      )
    )
    .returning();
  return row;
}

export async function markBrowserRunDeliveryAmbiguous(
  runId: string,
  token: string
) {
  const [row] = await db
    .update(browserRuns)
    .set({ deliveryState: "ambiguous", updatedAt: new Date() })
    .where(
      and(
        eq(browserRuns.id, runId),
        eq(browserRuns.deliveryToken, token),
        eq(browserRuns.deliveryState, "claimed")
      )
    )
    .returning();
  return row;
}

export async function releaseBrowserRunDeliveryClaim(options: {
  readonly lineageRevision: number;
  readonly rootRunId: string;
  readonly token: string;
}) {
  const [row] = await db
    .update(browserRuns)
    .set({
      deliveryClaimedAt: null,
      deliveryState: "pending",
      deliveryToken: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(browserRuns.id, options.rootRunId),
        eq(browserRuns.deliveryToken, options.token),
        eq(browserRuns.lineageRevision, options.lineageRevision),
        eq(browserRuns.deliveryState, "claimed"),
        isNotNull(browserRuns.completedAt)
      )
    )
    .returning();
  return row;
}

export async function markStaleBrowserRunDeliveryAmbiguous(options: {
  readonly claimedBefore: Date;
  readonly rootRunId: string;
}) {
  const [row] = await db
    .update(browserRuns)
    .set({ deliveryState: "ambiguous", updatedAt: new Date() })
    .where(
      and(
        eq(browserRuns.id, options.rootRunId),
        eq(browserRuns.deliveryState, "claimed"),
        lt(browserRuns.deliveryClaimedAt, options.claimedBefore)
      )
    )
    .returning();
  return row;
}

export async function listBrowserRunsForReconciliation(options: {
  readonly limit: number;
  readonly staleBefore: Date;
}) {
  return db
    .select()
    .from(browserRuns)
    .where(
      and(
        or(
          eq(browserRuns.id, browserRuns.rootRunId),
          isNull(browserRuns.rootRunId)
        ),
        or(
          and(
            isNull(browserRuns.completedAt),
            lt(browserRuns.updatedAt, options.staleBefore)
          ),
          and(
            isNotNull(browserRuns.completedAt),
            inArray(browserRuns.deliveryState, ["pending", "claimed"])
          ),
          and(
            inArray(browserRuns.lineageState, [
              "claimed",
              "creating",
              "recovering",
            ]),
            lt(browserRuns.updatedAt, options.staleBefore)
          )
        )
      )
    )
    .orderBy(asc(browserRuns.updatedAt))
    .limit(options.limit);
}

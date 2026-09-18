import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { browserProfiles, browserRuns, db } from "@db";
import { ensureScope } from "./scope";

type BrowserRunInsert = typeof browserRuns.$inferInsert;

const activeBrowserRunStatuses = ["created", "running", "waiting"] as const;

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

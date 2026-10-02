import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import {
  db,
  memoryDigestRuns,
  memoryScopes,
  userProfiles,
  workspaces,
  workstreams,
} from "@db";

/**
 * Workspaces with something for the daily memory digest — profile memory or
 * workstreams — with their time zone, and the local days the digest has
 * already done for them since `since`.
 */
export async function listMemoryDigestWorkspaces(since: string) {
  const [candidates, done] = await Promise.all([
    db
      .select({ timeZone: userProfiles.timezone, workspaceId: workspaces.id })
      .from(workspaces)
      .leftJoin(userProfiles, eq(userProfiles.workspaceId, workspaces.id))
      .where(
        or(
          sql`EXISTS (SELECT 1 FROM ${memoryScopes} WHERE ${memoryScopes.workspaceId} = ${workspaces.id})`,
          sql`EXISTS (SELECT 1 FROM ${workstreams} WHERE ${workstreams.workspaceId} = ${workspaces.id} AND ${workstreams.content} IS NOT NULL)`
        )
      ),
    db
      .select({
        localDate: memoryDigestRuns.localDate,
        workspaceId: memoryDigestRuns.workspaceId,
      })
      .from(memoryDigestRuns)
      .where(
        and(
          eq(memoryDigestRuns.status, "done"),
          gte(memoryDigestRuns.localDate, since)
        )
      ),
  ]);
  return candidates.map(({ timeZone, workspaceId }) => ({
    doneDates: done
      .filter((run) => run.workspaceId === workspaceId)
      .map(({ localDate }) => localDate),
    timeZone,
    workspaceId,
  }));
}

/**
 * Takes the workspace's local day for the digest, or reports that another
 * tick holds or has done it. A failed day, or one whose run outlived its
 * lease, is taken again.
 */
export async function claimMemoryDigestDay(
  workspaceId: string,
  localDate: string,
  leaseMs: number,
  now = new Date()
) {
  const running = {
    errorCode: null,
    finishedAt: null,
    leaseUntil: new Date(now.getTime() + leaseMs),
    outcome: null,
    startedAt: now,
    status: "running" as const,
  };
  const claimed = await db
    .insert(memoryDigestRuns)
    .values({ ...running, localDate, workspaceId })
    .onConflictDoUpdate({
      set: running,
      setWhere: or(
        eq(memoryDigestRuns.status, "failed"),
        and(
          eq(memoryDigestRuns.status, "running"),
          sql`${memoryDigestRuns.leaseUntil} < ${now}`
        )
      ),
      target: [memoryDigestRuns.workspaceId, memoryDigestRuns.localDate],
    })
    .returning({ workspaceId: memoryDigestRuns.workspaceId });
  return claimed.length > 0;
}

/**
 * Records how the day went — only while the run that claimed it at
 * `startedAt` still holds it: a run that outlived its lease leaves the day to
 * the one that took it over.
 */
export async function finishMemoryDigestDay(
  workspaceId: string,
  localDate: string,
  startedAt: Date,
  result:
    | { readonly outcome: Record<string, number> }
    | { readonly errorCode: string }
) {
  await db
    .update(memoryDigestRuns)
    .set({
      finishedAt: new Date(),
      ...("outcome" in result
        ? { outcome: result.outcome, status: "done" as const }
        : { errorCode: result.errorCode, status: "failed" as const }),
    })
    .where(
      and(
        eq(memoryDigestRuns.workspaceId, workspaceId),
        eq(memoryDigestRuns.localDate, localDate),
        eq(memoryDigestRuns.status, "running"),
        eq(memoryDigestRuns.startedAt, startedAt)
      )
    );
}

/** When the workspace's last digest that went through finished, if one did. */
export async function lastMemoryDigestFinishedAt(workspaceId: string) {
  const [last] = await db
    .select({ finishedAt: memoryDigestRuns.finishedAt })
    .from(memoryDigestRuns)
    .where(
      and(
        eq(memoryDigestRuns.workspaceId, workspaceId),
        eq(memoryDigestRuns.status, "done")
      )
    )
    .orderBy(desc(memoryDigestRuns.localDate))
    .limit(1);
  return last?.finishedAt ?? null;
}

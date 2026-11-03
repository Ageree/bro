import { and, count, eq, gt, gte, inArray, lt, max, sql } from "drizzle-orm";
import { capabilityTips, db, proactiveWatches, turnLog } from "@db";

/**
 * What a workspace's person has tried with Bro, from `turn_log`: how many
 * turns they started, every tool their turns and their errands' reports
 * called, and whether the mail check found Google connected; and when the
 * last tip went out. Bro's own turns (a schedule's or a mail check's worker)
 * are not the person trying anything and do not count.
 */
export async function readCapabilityHistory(workspaceId: string) {
  const [turns, tools, watch, tip] = await Promise.all([
    db
      .select({ turns: count() })
      .from(turnLog)
      .where(
        and(eq(turnLog.workspaceId, workspaceId), eq(turnLog.kind, "person"))
      ),
    db
      .selectDistinct({ tool: sql<string>`unnest(${turnLog.tools})` })
      .from(turnLog)
      .where(
        and(
          eq(turnLog.workspaceId, workspaceId),
          inArray(turnLog.kind, ["person", "browser-report"])
        )
      ),
    db
      .select({ googleState: proactiveWatches.googleState })
      .from(proactiveWatches)
      .where(eq(proactiveWatches.workspaceId, workspaceId))
      .limit(1),
    db
      .select({ at: max(capabilityTips.offeredAt) })
      .from(capabilityTips)
      .where(eq(capabilityTips.workspaceId, workspaceId)),
  ]);
  return {
    googleConnected: watch[0]?.googleState === "connected",
    lastTipAt: tip[0]?.at ?? null,
    personTurns: turns[0]?.turns ?? 0,
    tools: tools.map((row) => row.tool),
  };
}

/**
 * Claims a tip for the workspace: of `candidates`, in their order, the first
 * `limit` that rested `restMs` since they were last offered and were offered
 * fewer than `maxOffers` times, and marks them offered at `now`. Nothing,
 * when any tip went out less than `spacingMs` before. Under the workspace's
 * lock, so two messages at once claim one tip between them.
 */
export async function claimCapabilityTip(
  workspaceId: string,
  candidates: readonly string[],
  policy: {
    readonly limit: number;
    readonly maxOffers: number;
    readonly restMs: number;
    readonly spacingMs: number;
  },
  now = new Date()
) {
  if (candidates.length === 0) return [];
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`capability-tips:${workspaceId}`}))`
    );
    const offered = await transaction
      .select()
      .from(capabilityTips)
      .where(eq(capabilityTips.workspaceId, workspaceId));
    const since = (ms: number) => now.getTime() - ms;
    if (
      offered.some((row) => row.offeredAt.getTime() > since(policy.spacingMs))
    )
      return [];
    const rows = new Map(offered.map((row) => [row.capability, row]));
    const picked = candidates
      .filter((capability) => {
        const row = rows.get(capability);
        return (
          row === undefined ||
          (row.offers < policy.maxOffers &&
            row.offeredAt.getTime() <= since(policy.restMs))
        );
      })
      .slice(0, policy.limit);
    if (picked.length === 0) return [];
    await transaction
      .insert(capabilityTips)
      .values(
        picked.map((capability) => ({
          capability,
          offeredAt: now,
          workspaceId,
        }))
      )
      .onConflictDoUpdate({
        target: [capabilityTips.workspaceId, capabilityTips.capability],
        set: { offeredAt: now, offers: sql`${capabilityTips.offers} + 1` },
      });
    return picked;
  });
}

/**
 * People who talked to Bro and went quiet: at least `minTurns` turns of
 * their own in the last `goneMs`, the latest of them more than `quietMs`
 * ago, longest quiet first. Each comes with the user of their latest turn.
 */
export async function listQuietWorkspaces(
  now: Date,
  policy: {
    readonly goneMs: number;
    readonly limit: number;
    readonly minTurns: number;
    readonly quietMs: number;
  }
) {
  const latest = max(turnLog.startedAt);
  const rows = await db
    .select({
      latest,
      userId: sql<
        string | null
      >`(array_agg(${turnLog.userId} order by ${turnLog.startedAt} desc))[1]`,
      workspaceId: turnLog.workspaceId,
    })
    .from(turnLog)
    .where(
      and(
        eq(turnLog.kind, "person"),
        gt(turnLog.startedAt, new Date(now.getTime() - policy.goneMs))
      )
    )
    .groupBy(turnLog.workspaceId)
    .having(
      and(
        lt(latest, new Date(now.getTime() - policy.quietMs)),
        gte(count(), policy.minTurns)
      )
    )
    .orderBy(latest)
    .limit(policy.limit);
  return rows.flatMap((row) =>
    row.userId === null
      ? []
      : [{ userId: row.userId, workspaceId: row.workspaceId }]
  );
}

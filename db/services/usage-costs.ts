import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { browserVms, db, usageCosts, user, workspaceMemberships } from "@db";
import { vmFixedMonthlyRub } from "@shared/costs/prices";

type UsageCostInsert = typeof usageCosts.$inferInsert;
type UsageCostSource = (typeof usageCosts.$inferSelect)["source"];

const betterAuthPrincipalPrefix = "better-auth:";

/**
 * Write one cost, once: a second write with the same idempotency key — a
 * hook that ran again, a settled run read twice — changes nothing. Whether
 * this call wrote it.
 */
export async function recordUsageCost(
  input: Omit<UsageCostInsert, "id"> & { readonly idempotencyKey: string }
) {
  const rows = await db
    .insert(usageCosts)
    .values(input)
    .onConflictDoNothing({ target: usageCosts.idempotencyKey })
    .returning({ id: usageCosts.id });
  return rows.length > 0;
}

/**
 * A calendar month (`2026-09`) in Moscow time, where the owner and the
 * Cloud.ru bill both count days, as a half-open UTC window.
 */
function usageMonthWindow(month: string) {
  const match = /^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])$/u.exec(month);
  if (!match?.groups) throw new Error("A month is written as YYYY-MM.");
  const year = Number(match.groups.year);
  const index = Number(match.groups.month) - 1;
  const moscowOffsetMs = 3 * 60 * 60_000;
  return {
    from: new Date(Date.UTC(year, index, 1) - moscowOffsetMs),
    to: new Date(Date.UTC(year, index + 1, 1) - moscowOffsetMs),
  };
}

function emptyBySource(): Record<UsageCostSource, number> {
  return {
    background: 0,
    "browser-report": 0,
    "browser-run": 0,
    "browser-vm": 0,
    chat: 0,
    proxy: 0,
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * What each workspace cost in a month: the recorded costs by source, the
 * fixed monthly part of its VM if it has one (disk and address bill whether
 * the VM runs or not, so they are a line here rather than rows), and its
 * errands — every run id with a cost recorded against it that month —
 * with their average and largest cost. Roubles, two decimals.
 */
export async function summarizeUsageCosts(month: string) {
  const { from, to } = usageMonthWindow(month);
  const inMonth = and(
    gte(usageCosts.occurredAt, from),
    lt(usageCosts.occurredAt, to)
  );
  const [bySource, byRun, vms] = await Promise.all([
    db
      .select({
        costRub: sql<number>`sum(${usageCosts.costRub})::float8`,
        source: usageCosts.source,
        workspaceId: usageCosts.workspaceId,
      })
      .from(usageCosts)
      .where(inMonth)
      .groupBy(usageCosts.workspaceId, usageCosts.source),
    db
      .select({
        costRub: sql<number>`sum(${usageCosts.costRub})::float8`,
        runId: usageCosts.runId,
        workspaceId: usageCosts.workspaceId,
      })
      .from(usageCosts)
      .where(and(inMonth, isNotNull(usageCosts.runId)))
      .groupBy(usageCosts.workspaceId, usageCosts.runId),
    db
      .select({ workspaceId: browserVms.workspaceId })
      .from(browserVms)
      .where(isNotNull(browserVms.vmId)),
  ]);
  const fixedVmRub = vmFixedMonthlyRub.disk + vmFixedMonthlyRub.publicIp;
  const withVm = new Set(vms.map((vm) => vm.workspaceId));
  const workspaceIds = [
    ...new Set([...bySource.map((row) => row.workspaceId), ...withVm.values()]),
  ].toSorted();
  const emails = await ownerEmails(workspaceIds);

  const workspaces = workspaceIds.map((workspaceId) => {
    const sources = emptyBySource();
    for (const row of bySource) {
      if (row.workspaceId === workspaceId) {
        sources[row.source] = round(sources[row.source] + row.costRub);
      }
    }
    const errands = byRun
      .filter((row) => row.workspaceId === workspaceId)
      .toSorted((a, b) => b.costRub - a.costRub);
    const errandTotal = errands.reduce((sum, row) => sum + row.costRub, 0);
    const recordedRub = Object.values(sources).reduce((a, b) => a + b, 0);
    const fixed = withVm.has(workspaceId) ? fixedVmRub : 0;
    return {
      bySource: sources,
      errands: {
        averageRub:
          errands.length === 0 ? 0 : round(errandTotal / errands.length),
        count: errands.length,
        maxRub: round(errands[0]?.costRub ?? 0),
        maxRunId: errands[0]?.runId ?? null,
      },
      fixedVmRub: fixed,
      ownerEmail: emails.get(workspaceId) ?? null,
      recordedRub: round(recordedRub),
      totalRub: round(recordedRub + fixed),
      workspaceId,
    };
  });
  return {
    from: from.toISOString(),
    month,
    to: to.toISOString(),
    totalRub: round(workspaces.reduce((sum, row) => sum + row.totalRub, 0)),
    workspaces: workspaces.toSorted((a, b) => b.totalRub - a.totalRub),
  };
}

/**
 * Everything recorded against one errand's run: the browser agent, the
 * turns that reported it, its proxy traffic. Undefined for a run nothing was
 * recorded against.
 */
export async function errandUsageCosts(runId: string) {
  const rows = await db
    .select()
    .from(usageCosts)
    .where(eq(usageCosts.runId, runId))
    .orderBy(asc(usageCosts.occurredAt));
  const first = rows[0];
  if (first === undefined) return undefined;
  const bySource = emptyBySource();
  for (const row of rows) {
    bySource[row.source] = round(bySource[row.source] + row.costRub);
  }
  return {
    bySource,
    items: rows.map((row) => ({
      costRub: row.costRub,
      costUsd: row.costUsd,
      occurredAt: row.occurredAt.toISOString(),
      sessionId: row.sessionId,
      source: row.source,
      units: row.units,
    })),
    runId,
    totalRub: round(rows.reduce((sum, row) => sum + row.costRub, 0)),
    workspaceId: first.workspaceId,
  };
}

/** The sign-in email of each workspace's owner, where it has a Better Auth one. */
async function ownerEmails(workspaceIds: readonly string[]) {
  if (workspaceIds.length === 0) return new Map<string, string>();
  const rows = await db
    .select({
      email: user.email,
      workspaceId: workspaceMemberships.workspaceId,
    })
    .from(workspaceMemberships)
    .innerJoin(
      user,
      eq(
        sql`${betterAuthPrincipalPrefix} || ${user.id}`,
        workspaceMemberships.userId
      )
    )
    .where(
      and(
        inArray(workspaceMemberships.workspaceId, [...workspaceIds]),
        eq(workspaceMemberships.role, "owner")
      )
    );
  return new Map(rows.map((row) => [row.workspaceId, row.email]));
}

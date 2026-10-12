import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { agencyActionClasses, agencyActions, db } from "@db";

type AgencyActionInput = Pick<
  typeof agencyActions.$inferInsert,
  | "workspaceId"
  | "runId"
  | "tool"
  | "actionClass"
  | "counterparty"
  | "inputHash"
  | "summary"
  | "undo"
>;

/**
 * Records an action before it is taken. The input hash is the idempotency key:
 * a run that retries the same action finds the row it already wrote and must
 * not take the action again.
 */
export async function beginAgencyAction(input: AgencyActionInput) {
  const [row] = await db
    .insert(agencyActions)
    .values(input)
    .onConflictDoNothing({
      target: [agencyActions.workspaceId, agencyActions.inputHash],
    })
    .returning({ id: agencyActions.id });
  return row === undefined
    ? ({ kind: "duplicate" } as const)
    : ({ kind: "started", id: row.id } as const);
}

/**
 * Settles a planned action. Returns false when the row is not planned, so a
 * settled or unknown action is never settled twice. `undo` is the call that
 * reverses a done action, when the action has one.
 */
export async function finishAgencyAction(
  id: string,
  status: "done" | "failed",
  undo: AgencyActionInput["undo"] = null
) {
  const rows = await db
    .update(agencyActions)
    .set({ status, undo, updatedAt: new Date() })
    .where(and(eq(agencyActions.id, id), eq(agencyActions.status, "planned")))
    .returning({ id: agencyActions.id });
  return rows.length > 0;
}

/**
 * Whether an action with this input hash was ever recorded in the workspace,
 * whatever its status: a failed action is not retried either, since its
 * outcome may be unknown.
 */
export async function agencyActionRecorded(
  workspaceId: string,
  inputHash: string
) {
  const rows = await db
    .select({ id: agencyActions.id })
    .from(agencyActions)
    .where(
      and(
        eq(agencyActions.workspaceId, workspaceId),
        eq(agencyActions.inputHash, inputHash)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Actions per class that still count against the budget: planned or done
 * since `since`. Failed and undone actions do not count.
 */
export async function agencyBudgetUsage(workspaceId: string, since: Date) {
  const rows = await db
    .select({
      actionClass: agencyActions.actionClass,
      total: sql<number>`count(*)::int`,
    })
    .from(agencyActions)
    .where(
      and(
        eq(agencyActions.workspaceId, workspaceId),
        gte(agencyActions.createdAt, since),
        inArray(agencyActions.status, ["planned", "done"])
      )
    )
    .groupBy(agencyActions.actionClass);
  const usage = new Map<(typeof agencyActionClasses)[number], number>(
    agencyActionClasses.map((actionClass) => [actionClass, 0])
  );
  for (const row of rows) usage.set(row.actionClass, row.total);
  return usage;
}

/** The workspace's latest actions, newest first. */
export function listRecentAgencyActions(workspaceId: string, limit: number) {
  return db
    .select()
    .from(agencyActions)
    .where(eq(agencyActions.workspaceId, workspaceId))
    .orderBy(desc(agencyActions.createdAt))
    .limit(limit);
}

/**
 * Marks a done action undone after its reversal ran. Returns false when the
 * row is not done.
 */
export async function markAgencyActionUndone(id: string) {
  const rows = await db
    .update(agencyActions)
    .set({ status: "undone", updatedAt: new Date() })
    .where(and(eq(agencyActions.id, id), eq(agencyActions.status, "done")))
    .returning({ id: agencyActions.id });
  return rows.length > 0;
}

/**
 * The workspace's actions whose id starts with `idPrefix`: the short id the
 * person sees in the list, or the whole id. Two rows at most, so the caller
 * tells an unknown prefix from an ambiguous one.
 */
export function findAgencyActions(workspaceId: string, idPrefix: string) {
  return db
    .select()
    .from(agencyActions)
    .where(
      and(
        eq(agencyActions.workspaceId, workspaceId),
        sql`${agencyActions.id}::text LIKE ${`${idPrefix}%`}`
      )
    )
    .limit(2);
}

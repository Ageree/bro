import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
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

/** A planned row older than this is an abandoned run: its action may repeat. */
const plannedWindowMs = 30 * 60_000;
/** A done action is not repeated within this window; after it, the input may act again. */
const doneWindowMs = 7 * 24 * 60 * 60_000;

/**
 * The rows that refuse a repeat of their action now: planned and younger
 * than the planned window, or done within the done window. A failed send
 * refuses it too for the done window: the provider may have taken the letter
 * before the call threw, and a repeat would send it twice. A failed action of
 * another class, an undone row, a stale planned row and an old done row do not refuse it.
 */
function blockingSql(now: Date) {
  const plannedSince = new Date(now.getTime() - plannedWindowMs).toISOString();
  const doneSince = new Date(now.getTime() - doneWindowMs).toISOString();
  return sql`((${agencyActions.status} = 'planned' AND ${agencyActions.createdAt} >= ${plannedSince}::timestamptz) OR (${agencyActions.status} = 'done' AND ${agencyActions.createdAt} >= ${doneSince}::timestamptz) OR (${agencyActions.status} = 'failed' AND ${agencyActions.actionClass} = 'send' AND ${agencyActions.createdAt} >= ${doneSince}::timestamptz))`;
}

/**
 * Records an action before it is taken. The input hash is the idempotency key:
 * an identical action is refused while its row still blocks it (`blockingSql`).
 * A row that does not block is re-armed to planned in the same statement, so
 * the one row per hash, and its unique index, stay.
 */
export async function beginAgencyAction(input: AgencyActionInput) {
  const now = new Date();
  const [row] = await db
    .insert(agencyActions)
    .values(input)
    .onConflictDoUpdate({
      target: [agencyActions.workspaceId, agencyActions.inputHash],
      set: {
        actionClass: input.actionClass,
        counterparty: input.counterparty ?? null,
        createdAt: now,
        runId: input.runId ?? null,
        status: "planned",
        summary: input.summary,
        tool: input.tool,
        undo: null,
        updatedAt: now,
      },
      setWhere: sql`NOT ${blockingSql(now)}`,
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
 * Whether a repeat of an action with this input hash would be refused now:
 * its row is planned and recent, or done within the done window
 * (`blockingSql`). A failed, undone or stale row does not refuse it.
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
        eq(agencyActions.inputHash, inputHash),
        blockingSql(new Date())
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

/**
 * Forgets journal rows older than `before`: the repeat guard looks seven days
 * back and an undo a person asks for is recent, so older rows are clutter.
 */
export async function pruneAgencyActions(before: Date) {
  await db.delete(agencyActions).where(lt(agencyActions.createdAt, before));
}

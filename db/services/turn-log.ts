import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import {
  db,
  turnLog,
  turnLogEntries,
  usageCosts,
  user,
  workspaceMemberships,
} from "@db";

type TurnStart = Pick<
  typeof turnLog.$inferInsert,
  | "channel"
  | "kind"
  | "runId"
  | "sessionId"
  | "startedAt"
  | "turnId"
  | "userId"
  | "workspaceId"
>;

type TurnEntry = Pick<
  typeof turnLogEntries.$inferInsert,
  | "createdAt"
  | "eventId"
  | "part"
  | "role"
  | "sessionId"
  | "text"
  | "toolName"
  | "turnId"
  | "workspaceId"
>;

type TurnRef = Pick<typeof turnLog.$inferSelect, "sessionId" | "turnId">;

const hourMs = 60 * 60_000;
const dayMs = 24 * hourMs;

/**
 * An open row of the same session and turn id started this long before is
 * another turn under a reused id (a successor counts from `turn_0` again),
 * whose end never came; a younger one is this turn's `turn.started` emitted
 * again by a retried step.
 */
const reusedTurnAfterMs = 6 * hourMs;

/** How long a turn's metadata is kept: the owner's look back. */
const turnRetentionMs = 180 * dayMs;

const betterAuthPrincipalPrefix = "better-auth:";

/** The open row of a turn: at most one per session and turn id. */
function openTurn({ sessionId, turnId }: TurnRef) {
  return and(
    eq(turnLog.sessionId, sessionId),
    eq(turnLog.turnId, turnId),
    isNull(turnLog.endedAt)
  );
}

/**
 * Opens the row of a turn that started. The same turn's start emitted again
 * finds its row open and adds nothing; an open row of the same id from long
 * before was another turn, and is closed as `lost` first.
 */
export async function recordTurnStart(turn: TurnStart) {
  await db
    .update(turnLog)
    .set({ endedAt: turn.startedAt, outcome: "lost" })
    .where(
      and(
        openTurn(turn),
        lt(
          turnLog.startedAt,
          new Date(turn.startedAt.getTime() - reusedTurnAfterMs)
        )
      )
    );
  await db.insert(turnLog).values(turn).onConflictDoNothing();
}

/**
 * A model step of the turn finished: the count is the highest step seen, so
 * a retried step does not count twice.
 */
export async function recordTurnStep(turn: TurnRef, stepIndex: number) {
  await db
    .update(turnLog)
    .set({ steps: sql`greatest(${turnLog.steps}, ${stepIndex + 1})` })
    .where(openTurn(turn));
}

/** Tools the turn called, each name once, in the order first called. */
export async function recordTurnTools(turn: TurnRef, names: readonly string[]) {
  if (names.length === 0) return;
  const added = sql`array(
    select name from unnest(${sql.param([...new Set(names)])}::text[])
      with ordinality as requested(name, position)
    where not (name = any(${turnLog.tools}))
    order by position
  )`;
  await db
    .update(turnLog)
    .set({ tools: sql`${turnLog.tools} || ${added}` })
    .where(openTurn(turn));
}

/**
 * Closes the turn's row with how it ended, its length and its model steps'
 * cost from `usage_costs` (the step hook keys them by session, turn and
 * step). Returns the closed row, or undefined when no open row was found:
 * a turn that started before this table, or whose end came twice.
 */
export async function recordTurnEnd(
  turn: TurnRef,
  end: {
    readonly endedAt: Date;
    readonly errorCode?: string;
    readonly outcome: "cancelled" | "completed" | "failed";
  }
) {
  const stepKeyPrefix = `step:${turn.sessionId}:${turn.turnId}:`;
  const [row] = await db
    .update(turnLog)
    .set({
      costRub: sql`(
        select coalesce(sum(${usageCosts.costRub}), 0) from ${usageCosts}
        where ${usageCosts.occurredAt} >= ${turnLog.startedAt}
          and ${usageCosts.occurredAt} <= ${end.endedAt}
          and left(${usageCosts.idempotencyKey}, ${stepKeyPrefix.length}) = ${stepKeyPrefix}
      )`,
      durationMs: sql`greatest(0, round(extract(epoch from (${end.endedAt}::timestamptz - ${turnLog.startedAt})) * 1000))::int`,
      endedAt: end.endedAt,
      errorCode: end.errorCode ?? null,
      outcome: end.outcome,
    })
    .where(openTurn(turn))
    .returning();
  return row;
}

/**
 * How many people's turns failed with `errorCode` since `since`: the reach
 * of a provider's outage, told in one alert.
 */
export async function countFailedPeople(errorCode: string, since: Date) {
  const [row] = await db
    .select({
      people: sql<number>`count(distinct ${turnLog.workspaceId})::int`,
    })
    .from(turnLog)
    .where(
      and(
        eq(turnLog.kind, "person"),
        eq(turnLog.outcome, "failed"),
        eq(turnLog.errorCode, errorCode),
        gte(turnLog.startedAt, since)
      )
    );
  return row?.people ?? 0;
}

/** Keeps transcript lines; a line of an event already kept is skipped. */
export async function appendTurnEntries(entries: readonly TurnEntry[]) {
  const kept = entries.filter((entry) => entry.text.length > 0);
  if (kept.length === 0) return;
  await db.insert(turnLogEntries).values(kept).onConflictDoNothing();
}

/**
 * The hourly sweep: transcript lines older than the retention go, turns'
 * metadata after 180 days, and a turn still open after a day is closed as
 * `lost` (its end was never recorded).
 */
export async function expireTurnLog(retentionDays: number, now = new Date()) {
  await db
    .delete(turnLogEntries)
    .where(
      lt(
        turnLogEntries.createdAt,
        new Date(now.getTime() - retentionDays * dayMs)
      )
    );
  await db
    .delete(turnLog)
    .where(lt(turnLog.startedAt, new Date(now.getTime() - turnRetentionMs)));
  await db
    .update(turnLog)
    .set({ endedAt: now, outcome: "lost" })
    .where(
      and(
        isNull(turnLog.endedAt),
        lt(turnLog.startedAt, new Date(now.getTime() - dayMs))
      )
    );
}

/**
 * Who a workspace is to the owner: its owner account's name, phone and
 * email, and when the account signed up. A workspace without a Better Auth
 * owner (none today) has no entry.
 */
export async function workspaceAccounts(workspaceIds: readonly string[]) {
  if (workspaceIds.length === 0) return new Map<string, Account>();
  const rows = await db
    .select({
      createdAt: user.createdAt,
      email: user.email,
      name: user.name,
      phoneNumber: user.phoneNumber,
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
  return new Map(rows.map(({ workspaceId, ...row }) => [workspaceId, row]));
}

type Account = Pick<
  typeof user.$inferSelect,
  "createdAt" | "email" | "name" | "phoneNumber"
>;

/** The shortest way to name a workspace to the owner. */
export function workspaceLabel(
  workspaceId: string,
  account: Pick<Account, "email" | "name" | "phoneNumber"> | undefined
) {
  if (!account) return workspaceId;
  const name = account.name.trim();
  const contact = account.phoneNumber ?? account.email;
  return name.length > 0 && name !== contact ? `${name} (${contact})` : contact;
}

/**
 * Every workspace that had a turn, for the owner's list of people: who it
 * is, the channels it has used, when they signed up, their last turn of any
 * kind, their turns and failed turns within the last 24 hours, 7 days and 30
 * days, and what they cost (every source of `usage_costs`, not only turns)
 * within 24 hours and 30 days. Most recently active first. One pass over
 * `turn_log` and one over `usage_costs`, however many windows.
 */
export async function listOwnerUsers(now = new Date()) {
  const since = (hours: number) =>
    gte(turnLog.startedAt, new Date(now.getTime() - hours * hourMs));
  const day = since(24);
  const week = since(24 * 7);
  const failed = eq(turnLog.outcome, "failed");
  const [activity, costs] = await Promise.all([
    db
      .select({
        channels: sql<
          string[]
        >`array_agg(distinct ${turnLog.channel} order by ${turnLog.channel})`,
        failedDay: sql<number>`(count(*) filter (where ${and(day, failed)}))::int`,
        failedWeek: sql<number>`(count(*) filter (where ${and(week, failed)}))::int`,
        lastTurnAt: sql<Date>`max(${turnLog.startedAt})`.mapWith(
          turnLog.startedAt
        ),
        turnsDay: sql<number>`(count(*) filter (where ${day}))::int`,
        turnsWeek: sql<number>`(count(*) filter (where ${week}))::int`,
        workspaceId: turnLog.workspaceId,
      })
      .from(turnLog)
      .groupBy(turnLog.workspaceId),
    db
      .select({
        costDayRub: sql<number>`coalesce(sum(${usageCosts.costRub}) filter (where ${gte(usageCosts.occurredAt, new Date(now.getTime() - dayMs))}), 0)::float8`,
        costMonthRub: sql<number>`coalesce(sum(${usageCosts.costRub}), 0)::float8`,
        workspaceId: usageCosts.workspaceId,
      })
      .from(usageCosts)
      .where(gte(usageCosts.occurredAt, new Date(now.getTime() - 30 * dayMs)))
      .groupBy(usageCosts.workspaceId),
  ]);
  const costOf = new Map(costs.map((row) => [row.workspaceId, row]));
  const accounts = await workspaceAccounts(
    activity.map((row) => row.workspaceId)
  );
  return activity
    .map((row) => {
      const account = accounts.get(row.workspaceId);
      const cost = costOf.get(row.workspaceId);
      return {
        channels: row.channels,
        failedDay: row.failedDay,
        failedWeek: row.failedWeek,
        lastTurnAt: row.lastTurnAt,
        turnsDay: row.turnsDay,
        turnsWeek: row.turnsWeek,
        workspaceId: row.workspaceId,
        costDayRub: cost?.costDayRub ?? 0,
        costMonthRub: cost?.costMonthRub ?? 0,
        email: account?.email ?? null,
        label: workspaceLabel(row.workspaceId, account),
        name: account?.name ?? null,
        phone: account?.phoneNumber ?? null,
        signedUpAt: account?.createdAt ?? null,
      };
    })
    .toSorted((a, b) => b.lastTurnAt.getTime() - a.lastTurnAt.getTime());
}

/** Who one workspace is to the owner, for the title of its page. */
export async function describeWorkspace(workspaceId: string) {
  const accounts = await workspaceAccounts([workspaceId]);
  return workspaceLabel(workspaceId, accounts.get(workspaceId));
}

/** One workspace's turns that started within `[from, to)`, newest first. */
export async function listWorkspaceTurns(
  workspaceId: string,
  window: {
    readonly failedOnly?: boolean;
    readonly from: Date;
    readonly limit?: number;
    readonly to: Date;
  }
) {
  return db
    .select()
    .from(turnLog)
    .where(
      and(
        eq(turnLog.workspaceId, workspaceId),
        gte(turnLog.startedAt, window.from),
        lt(turnLog.startedAt, window.to),
        ...(window.failedOnly ? [eq(turnLog.outcome, "failed" as const)] : [])
      )
    )
    .orderBy(desc(turnLog.startedAt))
    .limit(window.limit ?? 200);
}

/**
 * A turn and the transcript lines kept for it, in order: the lines of its
 * session and turn id written between its start and its end (or now, for a
 * turn still running). Empty lines when OWNER_TRANSCRIPTS was off or they
 * expired; undefined for an unknown turn.
 */
export async function readTurnTranscript(turnLogId: string) {
  const [turn] = await db
    .select()
    .from(turnLog)
    .where(eq(turnLog.id, turnLogId))
    .limit(1);
  if (!turn) return undefined;
  const entries = await db
    .select({
      createdAt: turnLogEntries.createdAt,
      id: turnLogEntries.id,
      role: turnLogEntries.role,
      text: turnLogEntries.text,
      toolName: turnLogEntries.toolName,
    })
    .from(turnLogEntries)
    .where(
      and(
        eq(turnLogEntries.sessionId, turn.sessionId),
        eq(turnLogEntries.turnId, turn.turnId),
        gte(turnLogEntries.createdAt, turn.startedAt),
        ...(turn.endedAt
          ? [sql`${turnLogEntries.createdAt} <= ${turn.endedAt}`]
          : [])
      )
    )
    .orderBy(asc(turnLogEntries.createdAt), asc(turnLogEntries.id));
  return { entries, turn };
}

/**
 * The owner's daily summary over `[from, to)`: the people who wrote, the
 * turns by kind, failed turns by code, the cost per workspace (every source
 * of `usage_costs`) and the accounts that signed up.
 */
export async function summarizeOwnerDay(window: {
  readonly from: Date;
  readonly to: Date;
}) {
  const inWindow = and(
    gte(turnLog.startedAt, window.from),
    lt(turnLog.startedAt, window.to)
  );
  const [byKind, failures, people, costs, signedUp] = await Promise.all([
    db
      .select({ kind: turnLog.kind, turns: count() })
      .from(turnLog)
      .where(inWindow)
      .groupBy(turnLog.kind),
    db
      .select({
        errorCode: sql<string>`coalesce(${turnLog.errorCode}, '?')`,
        turns: count(),
      })
      .from(turnLog)
      .where(and(inWindow, eq(turnLog.outcome, "failed")))
      .groupBy(sql`coalesce(${turnLog.errorCode}, '?')`)
      .orderBy(desc(count())),
    db
      .selectDistinct({ workspaceId: turnLog.workspaceId })
      .from(turnLog)
      .where(and(inWindow, eq(turnLog.kind, "person"))),
    workspaceCosts(window),
    db
      .select({
        email: user.email,
        name: user.name,
        phoneNumber: user.phoneNumber,
      })
      .from(user)
      .where(
        and(gte(user.createdAt, window.from), lt(user.createdAt, window.to))
      )
      .orderBy(asc(user.createdAt)),
  ]);
  const accounts = await workspaceAccounts([...costs.keys()]);
  return {
    activePeople: people.length,
    costs: [...costs]
      .map(([workspaceId, costRub]) => ({
        costRub,
        label: workspaceLabel(workspaceId, accounts.get(workspaceId)),
        workspaceId,
      }))
      .toSorted((a, b) => b.costRub - a.costRub),
    failures,
    signedUp: signedUp.map((account) => workspaceLabel("", account)),
    turnsByKind: Object.fromEntries(byKind.map((row) => [row.kind, row.turns])),
  };
}

/** What each workspace cost within the window, every source, in roubles. */
async function workspaceCosts(window: {
  readonly from: Date;
  readonly to: Date;
}) {
  const rows = await db
    .select({
      costRub: sql<number>`sum(${usageCosts.costRub})::float8`,
      workspaceId: usageCosts.workspaceId,
    })
    .from(usageCosts)
    .where(
      and(
        gte(usageCosts.occurredAt, window.from),
        lt(usageCosts.occurredAt, window.to)
      )
    )
    .groupBy(usageCosts.workspaceId);
  return new Map(rows.map((row) => [row.workspaceId, row.costRub]));
}

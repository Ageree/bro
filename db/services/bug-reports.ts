import { and, count, eq, gte } from "drizzle-orm";
import { bugBotState, bugReportReplies, bugReports, db } from "@db";

const stateId = "bug-bot";

export type NewBugReport = Pick<
  typeof bugReports.$inferInsert,
  | "chatId"
  | "createdAt"
  | "firstName"
  | "photoFileId"
  | "telegramUserId"
  | "text"
  | "updateId"
  | "username"
  | "workspaceId"
>;

/** The next `getUpdates` offset and whether reading is paused (a 409). */
export async function readBugBotState(now = new Date()) {
  const [row] = await db
    .select()
    .from(bugBotState)
    .where(eq(bugBotState.id, stateId))
    .limit(1);
  return {
    nextOffset: row?.nextOffset ?? 0,
    paused: row?.pausedUntil
      ? row.pausedUntil.getTime() > now.getTime()
      : false,
  };
}

export async function saveBugBotState(state: {
  readonly nextOffset?: number;
  readonly pausedUntil?: Date | null;
}) {
  const { nextOffset, pausedUntil } = state;
  const set: Partial<typeof bugBotState.$inferInsert> = {};
  if (nextOffset !== undefined) set.nextOffset = nextOffset;
  if (pausedUntil !== undefined) set.pausedUntil = pausedUntil;
  await db
    .insert(bugBotState)
    .values({ id: stateId, nextOffset: nextOffset ?? 0, pausedUntil })
    .onConflictDoUpdate({ set, target: bugBotState.id });
}

/** Reports one person filed since `since`, for the hourly cap. */
export async function countRecentBugReports(
  telegramUserId: string,
  since: Date
) {
  const [row] = await db
    .select({ total: count() })
    .from(bugReports)
    .where(
      and(
        eq(bugReports.telegramUserId, telegramUserId),
        gte(bugReports.createdAt, since)
      )
    );
  return row?.total ?? 0;
}

/**
 * Files a report; undefined when this update was already filed, so a batch
 * read again after a crash neither duplicates nor answers it twice.
 */
export async function fileBugReport(report: NewBugReport) {
  const [row] = await db
    .insert(bugReports)
    .values(report)
    .onConflictDoNothing({ target: bugReports.updateId })
    .returning();
  return row;
}

export async function markBugReportForwarded(
  id: number,
  forwardMessageId: number
) {
  await db
    .update(bugReports)
    .set({ forwardMessageId, status: "forwarded" })
    .where(eq(bugReports.id, id));
}

export async function findBugReportByForward(forwardMessageId: number) {
  const [row] = await db
    .select()
    .from(bugReports)
    .where(eq(bugReports.forwardMessageId, forwardMessageId))
    .limit(1);
  return row;
}

/** Records the owner's answer once per update; false when it was already. */
export async function recordBugReportReply(reply: {
  readonly reportId: number;
  readonly text: string;
  readonly updateId: number;
}) {
  const rows = await db
    .insert(bugReportReplies)
    .values(reply)
    .onConflictDoNothing({ target: bugReportReplies.updateId })
    .returning({ id: bugReportReplies.id });
  if (rows.length === 0) return false;
  await db
    .update(bugReports)
    .set({ status: "answered" })
    .where(eq(bugReports.id, reply.reportId));
  return true;
}

/** Reports filed but not yet forwarded: a crash between the two steps. */
export async function listUnforwardedBugReports(limit = 20) {
  return await db
    .select()
    .from(bugReports)
    .where(eq(bugReports.status, "new"))
    .orderBy(bugReports.id)
    .limit(limit);
}

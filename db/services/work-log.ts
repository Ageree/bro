import { and, desc, eq, gt, gte, lt, lte, ne } from "drizzle-orm";
import { db, workLog } from "@db";

type WorkLine = Pick<
  typeof workLog.$inferInsert,
  "channel" | "createdAt" | "files" | "role" | "sessionId" | "text" | "turnId"
>;

/** The longest line kept, in characters (the table's CHECK). */
export const workLineLimit = 2000;

/** How long a line is kept. */
const retentionMs = 30 * 24 * 60 * 60_000;

/**
 * Keeps one line of a chat: its text with the whitespace trimmed, cut to
 * 2000 characters, and nothing for a line left empty. The same text of the
 * same side in one turn of a session is one line: a re-run step emits its
 * events again. Expired lines go in the hourly pass (`expireWorkLines`).
 */
export async function appendWorkLine(workspaceId: string, line: WorkLine) {
  const text = Array.from(line.text.trim()).slice(0, workLineLimit).join("");
  if (text.length === 0) return;
  await db
    .insert(workLog)
    .values({ ...line, text, workspaceId })
    .onConflictDoNothing();
}

/**
 * Deletes every line older than 30 days, whichever workspace and whether or
 * not it is still in the pilot. The hourly memory-history tick runs it.
 */
export async function expireWorkLines() {
  await db
    .delete(workLog)
    .where(lt(workLog.createdAt, new Date(Date.now() - retentionMs)));
}

/**
 * Every forget-all call: the workspace's lines go at once. With a period
 * («забудь, где я был вчера»), only the lines said in it: Bro's answers name
 * where the person was.
 */
export async function forgetWorkLines(
  workspaceId: string,
  period: { readonly from?: Date; readonly to?: Date } = {}
) {
  await db
    .delete(workLog)
    .where(
      and(
        eq(workLog.workspaceId, workspaceId),
        period.from === undefined
          ? undefined
          : gte(workLog.createdAt, period.from),
        period.to === undefined ? undefined : lte(workLog.createdAt, period.to)
      )
    );
}

/** When the session last had a line, or undefined for a chat with none. */
export async function lastWorkLineOfSession(
  workspaceId: string,
  sessionId: string
) {
  const [row] = await db
    .select({ at: workLog.createdAt })
    .from(workLog)
    .where(
      and(
        eq(workLog.workspaceId, workspaceId),
        eq(workLog.sessionId, sessionId)
      )
    )
    .orderBy(desc(workLog.createdAt))
    .limit(1);
  return row?.at;
}

/**
 * The workspace's lines newer than `since`, but `excludeSession`'s, the
 * newest `limit` of them, oldest first.
 */
export async function readWorkLines(
  workspaceId: string,
  options: {
    readonly excludeSession?: string;
    readonly limit: number;
    readonly since: Date;
  }
) {
  const rows = await db
    .select({
      createdAt: workLog.createdAt,
      files: workLog.files,
      role: workLog.role,
      sessionId: workLog.sessionId,
      text: workLog.text,
      turnId: workLog.turnId,
    })
    .from(workLog)
    .where(
      and(
        eq(workLog.workspaceId, workspaceId),
        gt(workLog.createdAt, options.since),
        options.excludeSession === undefined
          ? undefined
          : ne(workLog.sessionId, options.excludeSession)
      )
    )
    .orderBy(desc(workLog.createdAt))
    .limit(options.limit);
  return rows.toReversed();
}

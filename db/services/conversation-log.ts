import { and, desc, eq, gt, lt, ne } from "drizzle-orm";
import { conversationLog, db } from "@db";

type ConversationLine = Pick<
  typeof conversationLog.$inferInsert,
  "channel" | "createdAt" | "sessionId" | "text" | "turnId"
>;

/** The longest line kept, in characters (the table's CHECK). */
export const conversationLineLimit = 500;

/** How long a line is kept. */
const retentionMs = 14 * 24 * 60 * 60_000;

/**
 * Keeps one line the person said: its text with the whitespace trimmed, cut
 * to 500 characters, and nothing for a line left empty. `createdAt` is when
 * it was said, now by default. The same text in the same turn of a session
 * is one line: a re-run step emits its message again. Expired lines go in
 * the hourly pass (`expireConversationLines`), not here: a delete over every
 * workspace's lines on each message would cost every turn of the pilot.
 */
export async function appendConversationLine(
  workspaceId: string,
  line: ConversationLine
) {
  const text = Array.from(line.text.trim())
    .slice(0, conversationLineLimit)
    .join("");
  if (text.length === 0) return;
  await db
    .insert(conversationLog)
    .values({ ...line, text, workspaceId })
    .onConflictDoNothing();
}

/**
 * Deletes every line said more than 14 days ago, whichever workspace and
 * whether or not it is still in the pilot: a workspace that stopped writing
 * would keep its lines otherwise. The hourly memory-history tick runs it,
 * on every deployment (`agent/schedules/memory-history.ts`).
 */
export async function expireConversationLines() {
  await db
    .delete(conversationLog)
    .where(lt(conversationLog.createdAt, new Date(Date.now() - retentionMs)));
}

/**
 * Every forget-all call («удали всё, что ты про меня помнишь», «забудь …»):
 * the workspace's lines go at once, whatever memory is left.
 */
export async function forgetConversationLines(workspaceId: string) {
  await db
    .delete(conversationLog)
    .where(eq(conversationLog.workspaceId, workspaceId));
}

/**
 * The person's latest lines in the workspace from every channel but
 * `excludeChannel`, newer than `since`, at most `limit` of them, oldest
 * first.
 */
export async function readRecapLines(
  workspaceId: string,
  options: {
    readonly excludeChannel: string;
    readonly limit: number;
    readonly since: Date;
  }
) {
  const rows = await db
    .select({
      channel: conversationLog.channel,
      createdAt: conversationLog.createdAt,
      text: conversationLog.text,
    })
    .from(conversationLog)
    .where(
      and(
        eq(conversationLog.workspaceId, workspaceId),
        ne(conversationLog.channel, options.excludeChannel),
        gt(conversationLog.createdAt, options.since)
      )
    )
    .orderBy(desc(conversationLog.createdAt))
    .limit(options.limit);
  return rows.toReversed();
}

/**
 * When the workspace's conversation last had a line: a session (a web chat)
 * or, for a messenger, whose one private chat is the whole channel, the
 * channel.
 */
export async function lastLineOfConversation(
  workspaceId: string,
  conversation: { readonly sessionId: string } | { readonly channel: string }
) {
  const [row] = await db
    .select({ at: conversationLog.createdAt })
    .from(conversationLog)
    .where(
      and(
        eq(conversationLog.workspaceId, workspaceId),
        "sessionId" in conversation
          ? eq(conversationLog.sessionId, conversation.sessionId)
          : eq(conversationLog.channel, conversation.channel)
      )
    )
    .orderBy(desc(conversationLog.createdAt))
    .limit(1);
  return row?.at;
}

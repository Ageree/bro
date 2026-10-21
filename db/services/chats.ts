import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  chatListSchema,
  type ChatCursor,
  type ChatSummary,
  type ChatUsage,
  type SaveChat,
} from "@shared/chat/schema";
import { defaultChatTitle, shownChatTitle } from "@shared/chat/title";
import { chats, db } from "@db";
import { ensureScope } from "./scope";
import { waitForSessionOwnership } from "./sessions";

const chatRowSchema = z.object({
  channel: z.string().min(1).nullable(),
  costUsd: z.number().nonnegative().nullable(),
  createdAt: z.coerce.date(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  title: z.string().min(1),
  updatedAt: z.coerce.date(),
});

function toChatSummary(row: z.infer<typeof chatRowSchema>): ChatSummary {
  const {
    costUsd,
    createdAt,
    inputTokens,
    outputTokens,
    title,
    updatedAt,
    ...chat
  } = row;
  return {
    ...chat,
    title: shownChatTitle(title),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    usage: { costUsd, inputTokens, outputTokens },
  };
}

/** How many chats one page of «Все чаты» shows. */
export const chatPageSize = 40;

/**
 * One page of the workspace's chats, newest first. The page continues after
 * `cursor` by the `(updated_at, session_id)` key, so it reads only its own rows
 * from `chats_workspace_updated_session_idx` however long the history is.
 */
export async function listChatsPage(scope: AccessScope, cursor?: ChatCursor) {
  const rows = chatRowSchema.array().parse(
    await db
      .select()
      .from(chats)
      .where(
        and(
          eq(chats.workspaceId, scope.workspaceId),
          cursor
            ? sql`(${chats.updatedAt}, ${chats.sessionId}) < (${cursor.updatedAt}::timestamptz, ${cursor.sessionId})`
            : undefined
        )
      )
      .orderBy(desc(chats.updatedAt), desc(chats.sessionId))
      .limit(chatPageSize + 1)
  );
  const page = chatListSchema.parse(
    rows.slice(0, chatPageSize).map(toChatSummary)
  );
  const last = page.at(-1);
  return {
    chats: page,
    next:
      rows.length > chatPageSize && last
        ? { sessionId: last.sessionId, updatedAt: last.updatedAt }
        : null,
  };
}

const chatTotalsSchema = z.object({
  count: z.coerce.number().int().nonnegative(),
  costUsd: z.coerce.number().nonnegative().nullable(),
  inputTokens: z.coerce.number().int().nonnegative(),
  measured: z.boolean().nullable(),
  outputTokens: z.coerce.number().int().nonnegative(),
  unmeasured: z.boolean().nullable(),
});

/**
 * The number of chats and their combined usage, counted by the database. The
 * cost is known only when every chat that spent tokens has a cost.
 */
export async function summarizeChats(scope: AccessScope): Promise<{
  readonly count: number;
  readonly usage: ChatUsage;
}> {
  const [row] = await db
    .select({
      count: sql`count(*)`,
      costUsd: sql`sum(${chats.costUsd})`,
      inputTokens: sql`coalesce(sum(${chats.inputTokens}), 0)`,
      measured: sql`bool_or(${chats.costUsd} IS NOT NULL)`,
      outputTokens: sql`coalesce(sum(${chats.outputTokens}), 0)`,
      unmeasured: sql`bool_or(${chats.costUsd} IS NULL AND ${chats.inputTokens} + ${chats.outputTokens} > 0)`,
    })
    .from(chats)
    .where(eq(chats.workspaceId, scope.workspaceId));
  const totals = chatTotalsSchema.parse(row);
  return {
    count: totals.count,
    usage: {
      costUsd:
        totals.measured === true && totals.unmeasured !== true
          ? totals.costUsd
          : null,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
    },
  };
}

/** The newest chat of each given channel, in the order «Все чаты» lists them. */
export async function newestChatsOfChannels(
  scope: AccessScope,
  channels: readonly string[]
) {
  return z
    .object({ channel: z.string(), sessionId: z.string() })
    .array()
    .parse(
      await db
        .selectDistinctOn([chats.channel], {
          channel: chats.channel,
          sessionId: chats.sessionId,
        })
        .from(chats)
        .where(
          and(
            eq(chats.workspaceId, scope.workspaceId),
            inArray(chats.channel, [...channels])
          )
        )
        .orderBy(chats.channel, desc(chats.updatedAt), desc(chats.sessionId))
    );
}

export async function readChat(scope: AccessScope, sessionId: string) {
  const rows = await db
    .select()
    .from(chats)
    .where(
      and(
        eq(chats.workspaceId, scope.workspaceId),
        eq(chats.sessionId, sessionId)
      )
    )
    .limit(1);
  const row = chatRowSchema.optional().parse(rows[0]);
  return row ? toChatSummary(row) : undefined;
}

/**
 * Whether this workspace has talked to Bro in any conversation other than the
 * given session, in any channel. A chat row is written when a session receives
 * its first message.
 */
export async function hasOtherConversations(
  scope: AccessScope,
  sessionId: string
) {
  const rows = await db
    .select({ sessionId: chats.sessionId })
    .from(chats)
    .where(
      and(
        eq(chats.workspaceId, scope.workspaceId),
        ne(chats.sessionId, sessionId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function saveChat(
  scope: AccessScope,
  chat: SaveChat & { readonly channel?: string }
) {
  // A session outside this workspace is indistinguishable from an unknown one.
  if (!(await waitForSessionOwnership(scope, chat.sessionId))) return;
  await ensureScope(scope);
  const now = new Date();
  const existing = await db
    .select({ sessionId: chats.sessionId })
    .from(chats)
    .where(
      and(
        eq(chats.workspaceId, scope.workspaceId),
        eq(chats.sessionId, chat.sessionId)
      )
    );
  if (existing.length === 0) {
    await db.insert(chats).values({
      channel: chat.channel ?? null,
      costUsd: chat.usage?.costUsd ?? null,
      createdAt: now,
      inputTokens: chat.usage?.inputTokens ?? 0,
      outputTokens: chat.usage?.outputTokens ?? 0,
      sessionId: chat.sessionId,
      title: chat.title ?? defaultChatTitle,
      updatedAt: now,
      workspaceId: scope.workspaceId,
    });
    return;
  }
  const updates: Partial<typeof chats.$inferInsert> = { updatedAt: now };
  if (chat.channel !== undefined) updates.channel = chat.channel;
  if (chat.title !== undefined) updates.title = chat.title;
  if (chat.usage !== undefined) {
    updates.costUsd = chat.usage.costUsd;
    updates.inputTokens = chat.usage.inputTokens;
    updates.outputTokens = chat.usage.outputTokens;
  }
  await db
    .update(chats)
    .set(updates)
    .where(
      and(
        eq(chats.workspaceId, scope.workspaceId),
        eq(chats.sessionId, chat.sessionId)
      )
    );
}

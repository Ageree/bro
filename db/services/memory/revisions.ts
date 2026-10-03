import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, memoryRevisions } from "@db";
import { isSafeMemoryText } from "@shared/memory/schema";

/** How many revisions of a memory its history keeps. */
const keptRevisions = 10;

/**
 * Wipes every revision text in the workspace's history that carries a
 * credential or a one-time code, in its text or an alias; returns how many.
 * The filter grew stricter after some were written.
 */
export async function wipeUnsafeMemoryHistory(workspaceId: string) {
  const rows = await db
    .select({
      content: memoryRevisions.content,
      recordIndex: memoryRevisions.recordIndex,
      revision: memoryRevisions.revision,
      scopeKey: memoryRevisions.scopeKey,
    })
    .from(memoryRevisions)
    .where(
      and(
        eq(memoryRevisions.workspaceId, workspaceId),
        isNotNull(memoryRevisions.content)
      )
    );
  const unsafe = rows.filter(
    ({ content }) =>
      content !== null &&
      ![content.text, ...content.aliases].every(isSafeMemoryText)
  );
  for (const row of unsafe) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Rare, and one statement at a time keeps the pool free.
    await db
      .update(memoryRevisions)
      .set({ content: null, sessionId: null })
      .where(
        and(
          eq(memoryRevisions.workspaceId, workspaceId),
          eq(memoryRevisions.scopeKey, row.scopeKey),
          eq(memoryRevisions.recordIndex, row.recordIndex),
          eq(memoryRevisions.revision, row.revision)
        )
      );
  }
  return unsafe.length;
}

/**
 * Drops all but the last ten revisions of each memory in the workspace's
 * history; returns how many went.
 */
export async function trimMemoryHistory(workspaceId: string) {
  const trimmed = await db
    .delete(memoryRevisions)
    .where(
      and(
        eq(memoryRevisions.workspaceId, workspaceId),
        sql`(${memoryRevisions.scopeKey}, ${memoryRevisions.recordIndex}, ${memoryRevisions.revision}) IN (
          SELECT scope_key, record_index, revision FROM (
            SELECT scope_key, record_index, revision,
              row_number() OVER (
                PARTITION BY scope_key, record_index ORDER BY revision DESC
              ) AS rank
            FROM ${memoryRevisions}
            WHERE workspace_id = ${workspaceId}
          ) AS ranked
          WHERE rank > ${keptRevisions}
        )`
      )
    )
    .returning({ revision: memoryRevisions.revision });
  return trimmed.length;
}

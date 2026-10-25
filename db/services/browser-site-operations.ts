import { and, eq, sql } from "drizzle-orm";
import { browserSiteOperations, db } from "@db";

type SiteOperationRow = Pick<
  typeof browserSiteOperations.$inferInsert,
  "host" | "name" | "operation"
>;

/**
 * The workspace's operations, the most often found first. Another
 * workspace's are never among them: the workspace is part of every read.
 */
export async function listBrowserSiteOperations(workspaceId: string) {
  return db
    .select()
    .from(browserSiteOperations)
    .where(eq(browserSiteOperations.workspaceId, workspaceId))
    .orderBy(
      sql`${browserSiteOperations.runs} DESC`,
      sql`${browserSiteOperations.updatedAt} DESC`
    )
    .limit(200);
}

/**
 * Keeps an operation for the workspace, or counts one more run that found
 * it: the latest find replaces what is kept of it.
 */
export async function saveBrowserSiteOperation(
  workspaceId: string,
  row: SiteOperationRow & { readonly runs?: number }
) {
  const now = new Date();
  await db
    .insert(browserSiteOperations)
    .values({ ...row, runs: row.runs ?? 1, updatedAt: now, workspaceId })
    .onConflictDoUpdate({
      set: {
        host: row.host,
        operation: row.operation,
        runs: sql`${browserSiteOperations.runs} + excluded.runs`,
        updatedAt: now,
      },
      target: [browserSiteOperations.workspaceId, browserSiteOperations.name],
    });
}

/** The workspace's operation by its name, gone (a broader one replaced it). */
export async function deleteBrowserSiteOperation(
  workspaceId: string,
  name: string
) {
  await db
    .delete(browserSiteOperations)
    .where(
      and(
        eq(browserSiteOperations.workspaceId, workspaceId),
        eq(browserSiteOperations.name, name)
      )
    );
}

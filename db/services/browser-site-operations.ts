import { and, eq, gte, notInArray, sql } from "drizzle-orm";
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
      // A run that found it otherwise than it was kept read its site anew:
      // whatever reads of the old one failed are over. Found again as it
      // was, it is the same operation, and its failures stand: a page that
      // shows the same list whatever it is asked (letu.ru on the stand,
      // 25.10) is found the same every time.
      set: {
        failedAt: sql`CASE WHEN ${browserSiteOperations.operation} = excluded.operation THEN ${browserSiteOperations.failedAt} END`,
        failures: sql`CASE WHEN ${browserSiteOperations.operation} = excluded.operation THEN ${browserSiteOperations.failures} ELSE 0 END`,
        host: row.host,
        lastFailure: sql`CASE WHEN ${browserSiteOperations.operation} = excluded.operation THEN ${browserSiteOperations.lastFailure} END`,
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

/**
 * A read of one of the workspace's operations (or of a reviewed one, whose
 * row then holds its health alone, `runs` 0): one that gave results ends
 * its failures, and counts as served when it was Bro's own read with no
 * run; one that found the site changed (`readCounts` in
 * agent/lib/browser-vm/site-ops/health.ts) adds one to them.
 */
export async function noteBrowserSiteOperationRead(
  workspaceId: string,
  row: SiteOperationRow,
  outcome:
    | { readonly direct: boolean; readonly ok: true }
    | { readonly ok: false; readonly reason: string }
) {
  const now = new Date();
  const served = outcome.ok && outcome.direct ? 1 : 0;
  await db
    .insert(browserSiteOperations)
    .values({
      ...row,
      failedAt: outcome.ok ? null : now,
      failures: outcome.ok ? 0 : 1,
      lastFailure: outcome.ok ? null : outcome.reason,
      runs: 0,
      served,
      updatedAt: now,
      workspaceId,
    })
    .onConflictDoUpdate({
      set: outcome.ok
        ? {
            failedAt: null,
            failures: 0,
            lastFailure: null,
            served: sql`${browserSiteOperations.served} + ${served}`,
          }
        : {
            failedAt: now,
            failures: sql`${browserSiteOperations.failures} + 1`,
            lastFailure: outcome.reason,
          },
      target: [browserSiteOperations.workspaceId, browserSiteOperations.name],
    });
}

/**
 * The workspace's operations on a host that stopped reading their site
 * (`failures` at least `brokenAfter`), gone once a run found the host's
 * operation anew: the find replaces them. A reviewed operation's row stays
 * (`keep`): it is its health, not a find.
 */
export async function dropBrokenBrowserSiteOperations(
  workspaceId: string,
  host: string,
  brokenAfter: number,
  keep: readonly string[]
) {
  await db
    .delete(browserSiteOperations)
    .where(
      and(
        eq(browserSiteOperations.workspaceId, workspaceId),
        eq(browserSiteOperations.host, host),
        gte(browserSiteOperations.failures, brokenAfter),
        notInArray(browserSiteOperations.name, ["", ...keep])
      )
    );
}

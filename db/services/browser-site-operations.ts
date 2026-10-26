import { and, desc, eq, gt, gte, lt, ne, notInArray, sql } from "drizzle-orm";
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
 * Other workspaces' operations that runs of two workspaces or more found
 * apart (`runs`, never on an `adopted` row), on the very host an errand
 * names (its leading `www.` aside) or by one name: a page one person alone
 * sees — a signed-in cabinet, a company's own subdomain, a user's own path —
 * is never found the same by another, and a host above or below the
 * errand's is another site. A row that stopped reading its site does not
 * count; of each name the latest kept find goes, the most found first, and
 * never which workspace kept it.
 */
export async function listSharedBrowserSiteOperations(
  workspaceId: string,
  where: { readonly host: string } | { readonly name: string },
  brokenAfter: number
) {
  const table = browserSiteOperations;
  const place =
    "name" in where
      ? eq(table.name, where.name)
      : sql`regexp_replace(${table.host}, '^www\\.', '') = ${where.host}`;
  const found = and(
    gt(table.runs, 0),
    eq(table.adopted, false),
    lt(table.failures, brokenAfter)
  );
  const apart = db
    .select({
      foundBy: sql<number>`count(DISTINCT ${table.workspaceId})::int`.as(
        "found_by"
      ),
      name: table.name,
    })
    .from(table)
    .where(and(found, place))
    .groupBy(table.name)
    .having(sql`count(DISTINCT ${table.workspaceId}) >= 2`)
    .as("apart");
  const rows = await db
    .selectDistinctOn([table.name], {
      foundBy: apart.foundBy,
      host: table.host,
      name: table.name,
      operation: table.operation,
    })
    .from(table)
    .innerJoin(apart, eq(apart.name, table.name))
    .where(and(ne(table.workspaceId, workspaceId), found))
    .orderBy(table.name, desc(table.updatedAt))
    .limit(200);
  return rows
    .toSorted((one, two) => two.foundBy - one.foundBy)
    .slice(0, 20)
    .map(({ host, name, operation }) => ({ host, name, operation }));
}

/**
 * Keeps an operation for the workspace, or counts one more run that found
 * it: the latest find replaces what is kept of it. A row made `adopted`
 * stays so, and one that was not never becomes so.
 */
export async function saveBrowserSiteOperation(
  workspaceId: string,
  row: SiteOperationRow & {
    /** The run read it through op() as another workspace's (`adopted`). */
    readonly adopted?: boolean;
    readonly runs?: number;
  }
) {
  const now = new Date();
  await db
    .insert(browserSiteOperations)
    .values({
      ...row,
      adopted: row.adopted ?? false,
      runs: row.runs ?? 1,
      updatedAt: now,
      workspaceId,
    })
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
 * A read of one of the workspace's operations (or of a reviewed or shared
 * one, whose row then holds its health alone, `runs` 0): one that gave results ends
 * its failures, and counts as served when it was Bro's own read with no
 * run; one that found the site changed (`readCounts` in
 * agent/lib/browser-vm/site-ops/health.ts) adds one to them.
 */
export async function noteBrowserSiteOperationRead(
  workspaceId: string,
  row: SiteOperationRow & {
    /**
     * A reviewed or another workspace's operation's health may need its row
     * made — the shared one is the workspace's own from then on; a find's
     * row exists, and one a find replaced meanwhile is not made again.
     */
    readonly adopted: boolean;
  },
  outcome:
    | { readonly direct: boolean; readonly ok: true }
    | { readonly ok: false; readonly reason: string }
) {
  const now = new Date();
  const served = outcome.ok && outcome.direct ? 1 : 0;
  if (!row.adopted) {
    await db
      .update(browserSiteOperations)
      .set(
        outcome.ok
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
            }
      )
      .where(
        and(
          eq(browserSiteOperations.workspaceId, workspaceId),
          eq(browserSiteOperations.name, row.name)
        )
      );
    return;
  }
  await db
    .insert(browserSiteOperations)
    .values({
      adopted: true,
      failedAt: outcome.ok ? null : now,
      host: row.host,
      name: row.name,
      operation: row.operation,
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

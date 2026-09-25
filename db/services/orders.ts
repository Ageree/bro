import { randomUUID } from "node:crypto";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { browserRuns, db, orders } from "@db";
import { ensureScope } from "./scope";

type OrderInsert = typeof orders.$inferInsert;

/**
 * Upserts one order on its merchant order number. Both completion paths — the
 * Browser Use webhook and the reconciling poller — may settle the same run, and
 * the parse is deterministic, so a second write lands on the same row instead
 * of duplicating the purchase. A later report of the same order that lists no
 * lines — the run that only confirmed 3-D Secure — keeps the lines already
 * recorded.
 */
export async function recordOrder(
  scope: AccessScope,
  order: Omit<OrderInsert, "id" | "workspaceId">
) {
  await ensureScope(scope);
  const [row] = await db
    .insert(orders)
    .values({ ...order, id: randomUUID(), workspaceId: scope.workspaceId })
    .onConflictDoUpdate({
      target: [orders.workspaceId, orders.merchant, orders.merchantOrderId],
      set: {
        browserRunId: order.browserRunId ?? null,
        items: sql`coalesce(excluded.items, ${orders.items})`,
        pickup: order.pickup ?? null,
        priceRub: order.priceRub,
        status: order.status ?? "placed",
        title: order.title,
      },
    })
    .returning();
  if (!row) throw new Error("The order could not be recorded.");
  return row;
}

/**
 * The newest orders, each with the errand that placed it: the site the run
 * was on and what the person confirmed. Ozon and Wildberries have a merchant
 * of their own; every other shop is `other`, and without the errand
 * `list_orders` could only call it «другой магазин» (EN D4).
 */
export async function listOrders(scope: AccessScope, limit = 20) {
  return await db
    .select({
      ...getTableColumns(orders),
      // What the person confirmed names the errand. A follow-up without a
      // card — a code, a 3-D Secure confirmation on the spend limit — was
      // started with the person's message as its task («4821»), so the
      // errand is the first run in the same browser session, which is the
      // one the person asked for.
      errand: sql<string | null>`coalesce(
        ${browserRuns.submission}->>'what',
        (select first_run.task from browser_runs first_run
          where first_run.workspace_id = ${orders.workspaceId}
            and first_run.session_id = ${browserRuns.sessionId}
          order by first_run.created_at asc limit 1),
        ${browserRuns.task}
      )`,
      site: browserRuns.site,
      where: sql<string | null>`${browserRuns.submission}->>'where'`,
    })
    .from(orders)
    .leftJoin(
      browserRuns,
      and(
        eq(browserRuns.id, orders.browserRunId),
        eq(browserRuns.workspaceId, orders.workspaceId)
      )
    )
    .where(eq(orders.workspaceId, scope.workspaceId))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}

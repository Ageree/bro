import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, orders } from "@db";
import { ensureScope } from "./scope";

type OrderInsert = typeof orders.$inferInsert;

/**
 * Upserts one order on its merchant order number. Both completion paths — the
 * Browser Use webhook and the reconciling poller — may settle the same run, and
 * the parse is deterministic, so a second write lands on the same row instead
 * of duplicating the purchase.
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

export async function listOrders(scope: AccessScope, limit = 20) {
  return await db
    .select()
    .from(orders)
    .where(eq(orders.workspaceId, scope.workspaceId))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}

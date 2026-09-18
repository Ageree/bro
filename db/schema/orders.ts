import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

export const orderMerchants = ["wb", "ozon", "other"] as const;
export const orderStatuses = ["placed", "cancelled", "unknown"] as const;

/**
 * What a finished browser errand bought, so «где мой заказ» is answered from
 * this table instead of a fresh scrape. The merchant's own order number is the
 * natural key inside a workspace: recording the same run twice — the webhook
 * and the reconciling poller both settle a run — lands on the same row.
 */
export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    merchant: text("merchant", { enum: orderMerchants }).notNull(),
    merchantOrderId: text("merchant_order_id").notNull(),
    title: text("title").notNull(),
    priceRub: integer("price_rub").notNull(),
    status: text("status", { enum: orderStatuses }).notNull().default("placed"),
    pickup: text("pickup"),
    browserRunId: text("browser_run_id"),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "orders_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    unique("orders_merchant_order_uidx").on(
      table.workspaceId,
      table.merchant,
      table.merchantOrderId
    ),
    check(
      "orders_merchant_check",
      sql`${table.merchant} IN ('wb', 'ozon', 'other')`
    ),
    check(
      "orders_status_check",
      sql`${table.status} IN ('placed', 'cancelled', 'unknown')`
    ),
    check("orders_price_rub_check", sql`${table.priceRub} >= 0`),
    index("orders_workspace_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const ordersRelations = relations(orders, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [orders.workspaceId],
    references: [workspaces.id],
  }),
}));

import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

export const paymentStatuses = [
  "created",
  "pending",
  "succeeded",
  "canceled",
] as const;

/**
 * Paid access is one date per workspace. Everything else about a subscription
 * — how it was bought, how often, for how long — is reconstructable from
 * `payments`, so the state the paywall reads stays a single comparison.
 */
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    workspaceId: text("workspace_id").primaryKey(),
    paidUntil: timestamp("paid_until", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "billing_accounts_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
  ]
);

export const payments = pgTable(
  "payments",
  {
    // The YooKassa payment id owns this row: the webhook re-fetch addresses a
    // payment by it, and making it the key is what keeps applying the same
    // payment twice impossible rather than merely unlikely.
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    amountRub: integer("amount_rub").notNull(),
    status: text("status", { enum: paymentStatuses })
      .notNull()
      .default("created"),
    paidUntilAfter: timestamp("paid_until_after", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "payments_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "payments_status_check",
      sql`${table.status} IN ('created', 'pending', 'succeeded', 'canceled')`
    ),
    check("payments_amount_rub_check", sql`${table.amountRub} >= 0`),
    index("payments_workspace_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
  ]
);

export const billingAccountsRelations = relations(
  billingAccounts,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [billingAccounts.workspaceId],
      references: [workspaces.id],
    }),
  })
);

export const paymentsRelations = relations(payments, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [payments.workspaceId],
    references: [workspaces.id],
  }),
}));

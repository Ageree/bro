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

export const spendEntryStatuses = ["reserved", "charged", "released"] as const;

/**
 * What allowed the payment: the monthly spend limit, the approval card the
 * person confirmed with its total, or a standing permission. Only `limit`
 * rows count against the spend limit and only `standing` rows against a
 * standing permission's month; `card` rows are the record a reported charge
 * is checked against.
 */
export const spendEntrySources = ["limit", "card", "standing"] as const;

/**
 * What Bro paid, or is about to pay, with the card bound for an errand: on
 * its own under the person's standing spend limit or a standing permission,
 * or on an approval card that named the total. A row is reserved before the card is bound, so two errands
 * started together cannot both spend the same remainder; it becomes charged
 * when the run reports an order and released when it ends without one. The
 * month is the workspace's own calendar month, pre-formatted like the usage
 * counters (`2026-09`), and never re-derived from a UTC window.
 */
export const spendEntries = pgTable(
  "spend_entries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    // The run currently carrying the payment. A background retry or a
    // follow-up takes the reservation over, so this moves with the errand.
    browserRunId: text("browser_run_id").notNull(),
    periodKey: text("period_key").notNull(),
    merchant: text("merchant"),
    category: text("category"),
    amountRub: integer("amount_rub").notNull(),
    feeRub: integer("fee_rub").notNull().default(0),
    status: text("status", { enum: spendEntryStatuses })
      .notNull()
      .default("reserved"),
    source: text("source", { enum: spendEntrySources })
      .notNull()
      .default("limit"),
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
      name: "spend_entries_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    unique("spend_entries_browser_run_uidx").on(table.browserRunId),
    check(
      "spend_entries_status_check",
      sql`${table.status} IN ('reserved', 'charged', 'released')`
    ),
    check(
      "spend_entries_amounts_check",
      sql`${table.amountRub} >= 0 AND ${table.feeRub} >= 0`
    ),
    check("spend_entries_period_key_check", sql`${table.periodKey} <> ''`),
    check(
      "spend_entries_source_check",
      sql`${table.source} IN ('limit', 'card', 'standing')`
    ),
    index("spend_entries_period_idx").on(table.workspaceId, table.periodKey),
  ]
);

export const spendEntriesRelations = relations(spendEntries, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [spendEntries.workspaceId],
    references: [workspaces.id],
  }),
}));

import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * `messages`, `browser_runs` and `image_generations` are the metered actions;
 * `paywall_notices` is the counter that keeps the over-limit reply to one bubble a day, and it
 * is a counter rather than a flag so the same atomic increment decides it.
 */
export const usageCounterKinds = [
  "messages",
  "browser_runs",
  "image_generations",
  "paywall_notices",
] as const;

/**
 * One row per workspace, metered action and local period. The period is a
 * pre-formatted calendar key (`2026-09-18` for a day, `2026-09` for a month)
 * in the workspace's own timezone, so a counter never has to be re-derived
 * from a UTC window when someone moves.
 */
export const usageCounters = pgTable(
  "usage_counters",
  {
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind", { enum: usageCounterKinds }).notNull(),
    periodKey: text("period_key").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.kind, table.periodKey],
      name: "usage_counters_pkey",
    }),
    foreignKey({
      name: "usage_counters_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "usage_counters_kind_check",
      sql`${table.kind} IN ('messages', 'browser_runs', 'image_generations', 'paywall_notices')`
    ),
    check("usage_counters_period_key_check", sql`${table.periodKey} <> ''`),
  ]
);

export const usageCountersRelations = relations(usageCounters, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [usageCounters.workspaceId],
    references: [workspaces.id],
  }),
}));

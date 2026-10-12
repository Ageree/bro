import { sql } from "drizzle-orm";
import type { z } from "zod";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/** What a background action does to the outside world, for the budget. */
export const agencyActionClasses = [
  "send",
  "calendar",
  "call",
  "submit",
  "other",
] as const;

/** `planned` counts against the budget before the call, `done` after it. */
export const agencyActionStatuses = [
  "planned",
  "done",
  "failed",
  "undone",
] as const;

/**
 * One row per action Bro takes on its own (a background run, not a message
 * the person sent this turn). The unique input hash makes a retried run
 * recognize the action it already took instead of taking it twice; the rows
 * feed the per-class budget and the list the person can undo from.
 */
export const agencyActions = pgTable(
  "agency_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id"),
    tool: text("tool").notNull(),
    actionClass: text("action_class", { enum: agencyActionClasses }).notNull(),
    counterparty: text("counterparty"),
    inputHash: text("input_hash").notNull(),
    status: text("status", { enum: agencyActionStatuses })
      .notNull()
      .default("planned"),
    // One human-readable line; never a secret or a message body.
    summary: text("summary").notNull(),
    // The call that reverses this action, when there is one.
    undo: jsonb("undo").$type<{
      tool: string;
      input: Record<string, z.infer<ReturnType<typeof z.json>>>;
    }>(),
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
      name: "agency_actions_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    uniqueIndex("agency_actions_idempotency_uidx").on(
      table.workspaceId,
      table.inputHash
    ),
    index("agency_actions_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt
    ),
    check(
      "agency_actions_action_class_check",
      sql`${table.actionClass} IN ('send', 'calendar', 'call', 'submit', 'other')`
    ),
    check(
      "agency_actions_status_check",
      sql`${table.status} IN ('planned', 'done', 'failed', 'undone')`
    ),
  ]
);

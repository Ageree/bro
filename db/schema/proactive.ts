import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { scheduledAgentJobs, scheduledAgentRuns } from "./schedules";
import { workspaceMemberships, workspaces } from "./workspaces";

/**
 * One row per workspace Bro may write to first. The conversation it writes to
 * lives on the hidden `proactive` job; this row keeps the check cadence and the
 * mail watermark the next check searches from.
 */
export const proactiveWatches = pgTable(
  "proactive_watches",
  {
    workspaceId: text("workspace_id").primaryKey(),
    createdByUserId: text("created_by_user_id").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => scheduledAgentJobs.id, { onDelete: "cascade" }),
    mailCheckedAt: timestamp("mail_checked_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    nextCheckAt: timestamp("next_check_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    googleState: text("google_state", {
      enum: ["unknown", "connected", "disconnected"],
    })
      .notNull()
      .default("unknown"),
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
      name: "proactive_watches_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "proactive_watches_google_state_check",
      sql`${table.googleState} IN ('unknown', 'connected', 'disconnected')`
    ),
    index("proactive_watches_due_idx").on(table.nextCheckAt),
  ]
);

/**
 * Every mail message and calendar event a proactive run was handed, so the
 * same item never reaches the person twice. A calendar key carries the event
 * start as well, so a moved flight is looked at again.
 */
export const proactiveSignals = pgTable(
  "proactive_signals",
  {
    workspaceId: text("workspace_id").notNull(),
    source: text("source", { enum: ["gmail", "calendar"] }).notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    itemId: text("item_id").notNull(),
    threadId: text("thread_id"),
    runId: uuid("run_id")
      .notNull()
      .references(() => scheduledAgentRuns.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.source, table.dedupeKey],
      name: "proactive_signals_pkey",
    }),
    foreignKey({
      name: "proactive_signals_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check(
      "proactive_signals_source_check",
      sql`${table.source} IN ('gmail', 'calendar')`
    ),
    index("proactive_signals_run_idx").on(table.runId),
    index("proactive_signals_created_idx").on(table.createdAt),
  ]
);

export const proactiveWatchesRelations = relations(
  proactiveWatches,
  ({ one }) => ({
    job: one(scheduledAgentJobs, {
      fields: [proactiveWatches.jobId],
      references: [scheduledAgentJobs.id],
    }),
  })
);

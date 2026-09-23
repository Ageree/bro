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
import { workspaceMemberships } from "./workspaces";

export const browserProfiles = pgTable(
  "browser_profiles",
  {
    workspaceId: text("workspace_id").primaryKey(),
    profileId: text("profile_id").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("browser_profiles_profile_id_check", sql`${table.profileId} <> ''`),
  ]
);

export const browserRuns = pgTable(
  "browser_runs",
  {
    // The Browser Use Cloud run id owns this row: every webhook delivery and
    // every poll addresses a run by it, so a second key would only add a way
    // for the two to disagree.
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    sessionId: text("session_id").notNull(),
    profileId: text("profile_id"),
    task: text("task").notNull(),
    // The origin the errand was pointed at. Recording an order reads it to
    // name the merchant, which the errand wording alone often does not.
    site: text("site"),
    status: text("status", {
      enum: ["created", "running", "waiting", "done", "failed", "stopped"],
    })
      .notNull()
      .default("created"),
    outcome: text("outcome"),
    liveViewUrl: text("live_view_url"),
    conversationChannel: text("conversation_channel", {
      enum: ["eve", "photon", "telegram"],
    }).notNull(),
    conversationId: text("conversation_id").notNull(),
    replyAnchorMessageId: text("reply_anchor_message_id"),
    rootSessionId: text("root_session_id"),
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
    completedAt: timestamp("completed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // The message that reports the settled run back into its conversation.
    // Settling and delivering are separate steps: a run can settle where its
    // conversation cannot be reached (an eve session from the cron), and the
    // report waits here until a delivery lands instead of being lost with it.
    report: text("report"),
    reportDeliveredAt: timestamp("report_delivered_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // A lease, not a status: the webhook and the poller may both try to
    // deliver, and whoever holds a fresh claim is the one sending.
    reportClaimedAt: timestamp("report_claimed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    reportAttempts: integer("report_attempts").notNull().default(0),
  },
  (table) => [
    foreignKey({
      name: "browser_runs_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "browser_runs_status_check",
      sql`${table.status} IN ('created', 'running', 'waiting', 'done', 'failed', 'stopped')`
    ),
    check(
      "browser_runs_conversation_channel_check",
      sql`${table.conversationChannel} IN ('eve', 'photon', 'telegram')`
    ),
    check(
      "browser_runs_conversation_id_check",
      sql`${table.conversationId} <> ''`
    ),
    index("browser_runs_workspace_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
    index("browser_runs_pending_idx").on(
      table.status,
      table.updatedAt.asc().nullsLast()
    ),
  ]
);

export const browserRunsRelations = relations(browserRuns, ({ one }) => ({
  membership: one(workspaceMemberships, {
    fields: [browserRuns.workspaceId, browserRuns.createdByUserId],
    references: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
  }),
}));

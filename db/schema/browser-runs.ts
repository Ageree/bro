import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { workspaceMemberships } from "./workspaces";
import type { BrowserCapability } from "@shared/browser/autonomy";
import type {
  BrowserVerificationPlan,
  BrowserVerificationReport,
} from "@shared/browser/verification";
import type { ScheduledBrowserOrigin } from "@shared/browser/scheduled";

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
    proxyCountryCode: text("proxy_country_code"),
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
    scheduledOrigin: jsonb("scheduled_origin").$type<ScheduledBrowserOrigin>(),
    rootRunId: text("root_run_id"),
    activeRunId: text("active_run_id"),
    parentRunId: text("parent_run_id"),
    lineageRevision: integer("lineage_revision").notNull().default(0),
    lineageState: text("lineage_state", {
      enum: [
        "active",
        "claimed",
        "creating",
        "recovering",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("active"),
    lineageToken: text("lineage_token"),
    lineageTask: text("lineage_task"),
    lineagePreviousRunId: text("lineage_previous_run_id"),
    lineageRecoveryToken: text("lineage_recovery_token"),
    lineageRecoveryClaimedAt: timestamp("lineage_recovery_claimed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    capability: text("capability")
      .$type<BrowserCapability>()
      .notNull()
      .default("browse"),
    verificationPlan:
      jsonb("verification_plan").$type<BrowserVerificationPlan>(),
    verificationReport: jsonb(
      "verification_report"
    ).$type<BrowserVerificationReport>(),
    finalTaskStatus: text("final_task_status", {
      enum: ["complete", "partial", "blocked", "invalid"],
    }),
    finalNeed: text("final_need"),
    repairCount: integer("repair_count").notNull().default(0),
    repairState: text("repair_state", {
      enum: ["none", "claimed", "creating", "running", "failed"],
    })
      .notNull()
      .default("none"),
    repairToken: text("repair_token"),
    repairTask: text("repair_task"),
    repairClaimedAt: timestamp("repair_claimed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    repairDeadline: timestamp("repair_deadline", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    deliveryState: text("delivery_state", {
      enum: ["pending", "claimed", "acked", "ambiguous"],
    })
      .notNull()
      .default("pending"),
    deliveryToken: text("delivery_token"),
    deliveryClaimedAt: timestamp("delivery_claimed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    deliveredAt: timestamp("delivered_at", {
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
    completedAt: timestamp("completed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
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
    check(
      "browser_runs_proxy_country_code_check",
      sql`${table.proxyCountryCode} IS NULL OR ${table.proxyCountryCode} ~ '^[a-z]{2}$'`
    ),
    check(
      "browser_runs_capability_check",
      sql`${table.capability} IN ('browse', 'prepare', 'purchase', 'send', 'account-change', 'delete')`
    ),
    check(
      "browser_runs_lineage_state_check",
      sql`${table.lineageState} IN ('active', 'claimed', 'creating', 'recovering', 'failed', 'cancelled')`
    ),
    check(
      "browser_runs_final_task_status_check",
      sql`${table.finalTaskStatus} IS NULL OR ${table.finalTaskStatus} IN ('complete', 'partial', 'blocked', 'invalid')`
    ),
    check(
      "browser_runs_repair_state_check",
      sql`${table.repairState} IN ('none', 'claimed', 'creating', 'running', 'failed')`
    ),
    check(
      "browser_runs_delivery_state_check",
      sql`${table.deliveryState} IN ('pending', 'claimed', 'acked', 'ambiguous')`
    ),
    check(
      "browser_runs_repair_count_check",
      sql`${table.repairCount} BETWEEN 0 AND 1`
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

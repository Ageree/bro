import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { ConfirmedSubmission } from "@shared/browser/submission";
import { workspaceMemberships, workspaces } from "./workspaces";

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
    // for the two to disagree. An errand queued before Browser Use had a free
    // browser for it has no run yet and holds a `queued:` id until it starts.
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    // Null only on an errand queued before it had a browser: such a row holds
    // a `queued:` id, and its run carries the session once it starts.
    sessionId: text("session_id"),
    profileId: text("profile_id"),
    task: text("task").notNull(),
    // The origin the errand was pointed at. Recording an order reads it to
    // name the merchant, which the errand wording alone often does not.
    site: text("site"),
    status: text("status", {
      enum: [
        "created",
        "queued",
        "running",
        "waiting",
        "done",
        "failed",
        "stopped",
      ],
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
    // Whether the run was started with the saved card bound. A background
    // retry binds the same secrets again, so it has to know.
    paymentAllowed: boolean("payment_allowed").notNull().default(false),
    // What the person approved on the card to submit in their name, or null
    // when the errand may only look. The errand's follow-ups and background
    // retries carry it; a new errand starts without one.
    submission: jsonb("submission").$type<ConfirmedSubmission>(),
    // Which attempt of its errand this run is against an anti-bot wall: the
    // run the person started is 1, each background retry adds one.
    captchaAttempt: integer("captcha_attempt").notNull().default(1),
    // A run parked on an anti-bot check, or an errand queued while Browser
    // Use had no free browser, waits here for the poller to start it.
    retryAt: timestamp("retry_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // The run that took the errand over, so a follow-up or a status check on
    // this id finds where the errand lives now.
    retriedAsRunId: text("retried_as_run_id"),
    // The full instruction a queued errand starts with, composed when the
    // person asked for it; cleared once a run carries it.
    pendingTask: text("pending_task"),
    // How many times the person changed a queued errand. The poller starts a
    // run from the revision it read and hands the errand over only while it
    // is still that one; a change that landed in between restarts it.
    queueRevision: integer("queue_revision").notNull().default(0),
    // When this run stopped holding a live browser: Bro stopped it, which is
    // what writes its cookies to the profile, or a follow-up took the
    // browser over, or it was found gone. Null while the run works or its
    // page waits for the person.
    browserReleasedAt: timestamp("browser_released_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // The site account a queued errand waits on: another errand of the
    // workspace holds a browser there, and two sign-ins at once send two
    // codes that cancel each other. Null for an errand waiting only for a
    // free browser.
    waitsForAccount: text("waits_for_account"),
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
      sql`${table.status} IN ('created', 'queued', 'running', 'waiting', 'done', 'failed', 'stopped')`
    ),
    check(
      "browser_runs_session_id_check",
      sql`${table.sessionId} IS NOT NULL OR ${table.id} LIKE 'queued:%'`
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
    index("browser_runs_retry_idx").on(table.retryAt),
    check(
      "browser_runs_captcha_attempt_check",
      sql`${table.captchaAttempt} >= 1`
    ),
  ]
);

/**
 * The sites where the workspace's browser profile is signed in to the
 * person's account, as the runs and the keep-alive visits last found it. A
 * run reports the page only a signed-in person sees; the keep-alive visit
 * opens that page every few days so the site's session stays fresh, and the
 * errand tool tells Bro not to warn about a code where the sign-in is kept.
 */
export const browserSignIns = pgTable(
  "browser_sign_ins",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The registrable domain of the account: `ozon.ru`, `gosuslugi.ru`.
    domain: text("domain").notNull(),
    // A page there only a signed-in person sees, as the run reported it,
    // without its query or fragment.
    accountUrl: text("account_url"),
    state: text("state", { enum: ["signed_in", "signed_out"] }).notNull(),
    // When an errand last found the person signed in there: the keep-alive
    // visits stop a month after the person stopped using the site.
    usedAt: timestamp("used_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    // When a run or a keep-alive visit last saw the state.
    checkedAt: timestamp("checked_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    // When the last keep-alive visit was claimed.
    refreshedAt: timestamp("refreshed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.domain] }),
    check(
      "browser_sign_ins_state_check",
      sql`${table.state} IN ('signed_in', 'signed_out')`
    ),
    check("browser_sign_ins_domain_check", sql`${table.domain} <> ''`),
    index("browser_sign_ins_refresh_idx").on(table.state, table.checkedAt),
  ]
);

export const browserRunsRelations = relations(browserRuns, ({ one }) => ({
  membership: one(workspaceMemberships, {
    fields: [browserRuns.workspaceId, browserRuns.createdByUserId],
    references: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
  }),
}));

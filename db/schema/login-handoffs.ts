import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { workspaceMemberships } from "./workspaces";

const at = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

/**
 * A sign-in the person does themselves, in a live view of their own cloud
 * browser, behind a link Bro sent them (`docs/login-handoff.md`). The row's
 * id is the link's secret and is never an address of the worker, which gets
 * its own id (`workerId`) when the link is opened.
 *
 * `pending`: the link was sent, nothing opened yet. `claimed`: the person
 * opened it from one device (`deviceHash`) and a tab waits on the browser.
 * Then `done` (they said they were through), `cancelled`, `expired` or
 * `failed`. A report of the end owes the conversation the link came from.
 */
export const loginHandoffs = pgTable(
  "login_handoffs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    // The registrable domain the person signs in to, and the page that opens.
    domain: text("domain").notNull(),
    siteUrl: text("site_url").notNull(),
    // The names the viewer's page may be on: the site and the sign-in
    // providers Bro knows.
    allowedDomains: text("allowed_domains").array().notNull(),
    state: text("state", {
      enum: ["pending", "claimed", "done", "cancelled", "expired", "failed"],
    })
      .notNull()
      .default("pending"),
    workerId: text("worker_id"),
    // sha256 of the secret the claiming device keeps in a cookie.
    deviceHash: text("device_hash"),
    createdAt: at("created_at").defaultNow().notNull(),
    // The link stops opening here; a claimed handoff lives to `viewUntil`.
    expiresAt: at("expires_at").notNull(),
    claimedAt: at("claimed_at"),
    // When the worker took the handoff in. Until then a worker that does not
    // know it is only not asked yet, not one that lost it.
    workerOpenedAt: at("worker_opened_at"),
    viewUntil: at("view_until"),
    finishedAt: at("finished_at"),
    // What the page showed when the person was through: the host, and
    // whether it was an account page rather than a form asking for a
    // password. Null until then, and when the worker could not tell.
    resultHost: text("result_host"),
    signedIn: boolean("signed_in"),
    conversationChannel: text("conversation_channel", {
      enum: ["eve", "photon", "telegram"],
    }).notNull(),
    conversationId: text("conversation_id").notNull(),
    replyAnchorMessageId: text("reply_anchor_message_id"),
    rootSessionId: text("root_session_id"),
    // The message that reports the end back; kept until a delivery lands.
    report: text("report"),
    reportClaimedAt: at("report_claimed_at"),
    reportDeliveredAt: at("report_delivered_at"),
    reportAttempts: integer("report_attempts").notNull().default(0),
  },
  (table) => [
    foreignKey({
      name: "login_handoffs_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "login_handoffs_state_check",
      sql`${table.state} IN ('pending', 'claimed', 'done', 'cancelled', 'expired', 'failed')`
    ),
    check(
      "login_handoffs_conversation_channel_check",
      sql`${table.conversationChannel} IN ('eve', 'photon', 'telegram')`
    ),
    check("login_handoffs_domain_check", sql`${table.domain} <> ''`),
    index("login_handoffs_workspace_idx").on(table.workspaceId, table.state),
    index("login_handoffs_state_idx").on(table.state, table.expiresAt),
  ]
);

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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  FlightCondition,
  FlightSource,
  FlightState,
} from "@shared/subscriptions/flight";
import type {
  PriceCondition,
  PriceSource,
  PriceState,
} from "@shared/subscriptions/price";
import { scheduledAgentJobs } from "./schedules";
import { workspaceMemberships } from "./workspaces";

/**
 * Something Bro watches for the person and code checks without the model
 * (docs/roadmap.md, 27): where to look (`source`), what counts as news
 * (`condition`), until when (`expires_at`), what a hit does (`action`) and
 * whether it may wake the person (`wake`). Only a hit reaches the model, as
 * the report turn of a run on the hidden `subscription` job, which also
 * carries the chat the reports go to. `next_check_at` is the lease of a
 * check in progress, as in `proactive_watches`.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => scheduledAgentJobs.id, { onDelete: "cascade" }),
    // `price`: the person asked (`watch-create`); `flight`: Bro watches each
    // flight in the calendar by itself, through the proactive job.
    template: text("template", { enum: ["price", "flight"] }).notNull(),
    // One live watch per thing: a price watch's key is its normalized URL,
    // a flight's its event and start.
    dedupeKey: text("dedupe_key").notNull(),
    // Typed per template; read through its schema (`agent/lib/subscriptions/`).
    source: jsonb("source").$type<FlightSource | PriceSource>().notNull(),
    condition: jsonb("condition")
      .$type<FlightCondition | PriceCondition>()
      .notNull(),
    // `notify`: code writes the hit, and only the report turn uses the model;
    // `worker`: a hit starts a run of the proactive worker.
    action: text("action", { enum: ["notify", "worker"] })
      .notNull()
      .default("notify"),
    // `day_only` holds a hit found at night for the morning;
    // `urgent_at_night` lets a time-sensitive one through.
    wake: text("wake", { enum: ["day_only", "urgent_at_night"] })
      .notNull()
      .default("day_only"),
    // What the checks remember: the first and the latest reading.
    state: jsonb("state").$type<FlightState | PriceState>().notNull(),
    status: text("status", {
      enum: ["active", "paused", "fired", "expired", "failed", "cancelled"],
    })
      .notNull()
      .default("active"),
    checkEverySeconds: integer("check_every_s").notNull(),
    nextCheckAt: timestamp("next_check_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    checks: integer("checks").notNull().default(0),
    // Failed checks in a row; a reading resets it.
    failures: integer("failures").notNull().default(0),
    hits: integer("hits").notNull().default(0),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    lastHitAt: timestamp("last_hit_at", {
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
      name: "subscriptions_membership_fkey",
      columns: [table.workspaceId, table.createdByUserId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "subscriptions_template_check",
      sql`${table.template} IN ('price', 'flight')`
    ),
    check(
      "subscriptions_action_check",
      sql`${table.action} IN ('notify', 'worker')`
    ),
    check(
      "subscriptions_wake_check",
      sql`${table.wake} IN ('day_only', 'urgent_at_night')`
    ),
    check(
      "subscriptions_status_check",
      sql`${table.status} IN ('active', 'paused', 'fired', 'expired', 'failed', 'cancelled')`
    ),
    check(
      "subscriptions_json_check",
      sql`jsonb_typeof(${table.source}) = 'object' AND jsonb_typeof(${table.condition}) = 'object' AND jsonb_typeof(${table.state}) = 'object'`
    ),
    check("subscriptions_dedupe_key_check", sql`${table.dedupeKey} <> ''`),
    // A price is read at most hourly: each reading is a request to a shop.
    check(
      "subscriptions_check_every_check",
      sql`${table.checkEverySeconds} >= 3600`
    ),
    check(
      "subscriptions_expires_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '90 days'`
    ),
    index("subscriptions_due_idx")
      .on(table.nextCheckAt)
      .where(sql`${table.status} = 'active'`),
    index("subscriptions_job_idx").on(table.jobId),
    // Deleting a membership cascades here by its two columns.
    index("subscriptions_owner_idx").on(
      table.workspaceId,
      table.createdByUserId
    ),
    uniqueIndex("subscriptions_live_idx")
      .on(
        table.workspaceId,
        table.createdByUserId,
        table.template,
        table.dedupeKey
      )
      .where(sql`${table.status} IN ('active', 'paused')`),
  ]
);

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  job: one(scheduledAgentJobs, {
    fields: [subscriptions.jobId],
    references: [scheduledAgentJobs.id],
  }),
}));

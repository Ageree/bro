import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * Where a cost came from. `chat` is a turn opened by the person's own
 * message on any channel; `background` a turn Bro opened for itself (a
 * schedule's or a mail check's worker, a schedule's report); `browser-report`
 * the turn that tells the person how a browser run went. `browser-run` is
 * the model of the agent inside the browser, `browser-vm` the time a
 * workspace VM was powered on, `proxy` residential traffic.
 */
export const usageCostSources = [
  "chat",
  "background",
  "browser-report",
  "browser-run",
  "browser-vm",
  "proxy",
] as const;

/** What was consumed, in whatever measure the source has. */
export interface UsageCostUnits {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly steps?: number;
  readonly seconds?: number;
  readonly bytes?: number;
  readonly model?: string;
  readonly flavor?: string;
  /** A VM stretch shared equally between this many runs (1: one or none). */
  readonly sharedBy?: number;
  /**
   * The share of a pool host's hourly price a sandbox's stretch is charged
   * at: its memory over what the host gives its sandboxes.
   */
  readonly hostShare?: number;
  /** No price was known: zero roubles here is not a free step. */
  readonly unpriced?: boolean;
}

/**
 * One cost Bro incurred for a workspace, in roubles at the time it was
 * written. `run_id` ties an errand together: the browser run, the turns that
 * reported it, its proxy traffic and its share of the VM's powered-on time.
 * `idempotency_key` is what a retried hook or a second read of a settled run
 * collides on, so nothing is counted twice.
 */
export const usageCosts = pgTable(
  "usage_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    source: text("source", { enum: usageCostSources }).notNull(),
    units: jsonb("units").$type<UsageCostUnits>().notNull().default({}),
    costRub: numeric("cost_rub", {
      mode: "number",
      precision: 14,
      scale: 6,
    }).notNull(),
    // The price as the provider gave it, for sources billed in dollars.
    costUsd: numeric("cost_usd", { mode: "number", precision: 14, scale: 8 }),
    runId: text("run_id"),
    sessionId: text("session_id"),
    occurredAt: timestamp("occurred_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (table) => [
    foreignKey({
      name: "usage_costs_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    unique("usage_costs_idempotency_key_uidx").on(table.idempotencyKey),
    check(
      "usage_costs_source_check",
      sql`${table.source} IN ('chat', 'background', 'browser-report', 'browser-run', 'browser-vm', 'proxy')`
    ),
    check("usage_costs_cost_rub_check", sql`${table.costRub} >= 0`),
    check(
      "usage_costs_cost_usd_check",
      sql`${table.costUsd} IS NULL OR ${table.costUsd} >= 0`
    ),
    check(
      "usage_costs_idempotency_key_check",
      sql`${table.idempotencyKey} <> ''`
    ),
    index("usage_costs_occurred_idx").on(table.occurredAt),
    index("usage_costs_run_idx").on(table.runId),
  ]
);

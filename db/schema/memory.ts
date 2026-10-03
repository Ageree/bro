import { sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { MemoryContent } from "@shared/memory/schema";
import { workspaces } from "./workspaces";

export const memoryScopes = pgTable(
  "memory_scopes",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    generation: integer("generation").notNull().default(1),
    lastAllocatedIndex: bigint("last_allocated_index", { mode: "number" })
      .notNull()
      .default(-1),
    legacyImportCompletedAt: timestamp("legacy_import_completed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    semanticIndexEnabled: boolean("semantic_index_enabled")
      .notNull()
      .default(true),
    /**
     * When Bro last read this scope's profile into a turn, at most hourly: a
     * workspace can hold more than one opaque eve scope key, and the one
     * recalled last is the one its conversations use.
     */
    lastRecalledAt: timestamp("last_recalled_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.scopeKey] }),
    check("memory_scopes_generation_check", sql`${table.generation} > 0`),
    check(
      "memory_scopes_last_index_check",
      sql`${table.lastAllocatedIndex} >= -1`
    ),
  ]
);

export const memoryRecords = pgTable(
  "memory_records",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    index: bigint("record_index", { mode: "number" }).notNull(),
    revision: integer("revision").notNull(),
    generation: integer("generation").notNull(),
    content: jsonb("content").$type<MemoryContent>(),
    lastOperationId: text("last_operation_id").notNull(),
    sourceSessionId: text("source_session_id"),
    sourceTurnId: text("source_turn_id"),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.scopeKey, table.index],
    }),
    uniqueIndex("memory_records_operation_idx").on(
      table.workspaceId,
      table.scopeKey,
      table.lastOperationId
    ),
    index("memory_records_recent_idx").on(
      table.workspaceId,
      table.scopeKey,
      table.updatedAt
    ),
    check("memory_records_index_check", sql`${table.index} >= 0`),
    check("memory_records_revision_check", sql`${table.revision} > 0`),
    check("memory_records_generation_check", sql`${table.generation} > 0`),
  ]
);

/** What a revision of a memory did, and who did it. */
export const memoryRevisionActions = [
  "save",
  "update",
  "restore",
  "forget",
  "expire",
  "import",
  "merge",
  "correct",
  "one_off",
  "purge",
] as const;
export const memoryRevisionActors = [
  "model",
  "person",
  "digest",
  "system",
] as const;

/**
 * Every revision of a memory, appended in the same transaction that writes
 * it: `content` is the record as that revision left it (null once forgotten
 * or expired). Forgetting wipes the text of the record's earlier revisions,
 * so history never keeps what the person asked Bro to forget.
 */
export const memoryRevisions = pgTable(
  "memory_revisions",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    recordIndex: bigint("record_index", { mode: "number" }).notNull(),
    revision: integer("revision").notNull(),
    content: jsonb("content").$type<MemoryContent>(),
    action: text("action", { enum: memoryRevisionActions }).notNull(),
    actor: text("actor", { enum: memoryRevisionActors }).notNull(),
    sessionId: text("session_id"),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.scopeKey,
        table.recordIndex,
        table.revision,
      ],
    }),
    index("memory_revisions_timeline_idx").on(
      table.workspaceId,
      table.scopeKey,
      table.createdAt
    ),
    check(
      "memory_revisions_action_check",
      sql`${table.action} IN ('save', 'update', 'restore', 'forget', 'expire', 'import', 'merge', 'correct', 'one_off', 'purge')`
    ),
    check(
      "memory_revisions_actor_check",
      sql`${table.actor} IN ('model', 'person', 'digest', 'system')`
    ),
    check("memory_revisions_index_check", sql`${table.recordIndex} >= 0`),
    check("memory_revisions_revision_check", sql`${table.revision} > 0`),
  ]
);

/**
 * One row per workspace and local day the daily memory digest ran for
 * (`agent/lib/memory/digest/run.ts`): the day's claim, so a tick does it once,
 * and its outcome — counts only, never memory text.
 */
export const memoryDigestRuns = pgTable(
  "memory_digest_runs",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    localDate: date("local_date", { mode: "string" }).notNull(),
    status: text("status", { enum: ["running", "done", "failed"] }).notNull(),
    leaseUntil: timestamp("lease_until", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    startedAt: timestamp("started_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    finishedAt: timestamp("finished_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    outcome: jsonb("outcome").$type<Record<string, number>>(),
    errorCode: text("error_code"),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.localDate] }),
    // The hourly tick reads the days done since yesterday, for everyone.
    index("memory_digest_runs_day_idx").on(table.localDate, table.status),
    check(
      "memory_digest_runs_status_check",
      sql`${table.status} IN ('running', 'done', 'failed')`
    ),
  ]
);

export const memoryOperations = pgTable(
  "memory_operations",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    operationId: text("operation_id").notNull(),
    recordIndex: bigint("record_index", { mode: "number" }).notNull(),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.scopeKey, table.operationId],
    }),
    check("memory_operations_index_check", sql`${table.recordIndex} >= 0`),
    check("memory_operations_revision_check", sql`${table.revision} > 0`),
  ]
);

export const memorySync = pgTable(
  "memory_sync",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    recordIndex: bigint("record_index", { mode: "number" }).notNull(),
    revision: integer("revision").notNull(),
    generation: integer("generation").notNull(),
    desiredPresent: boolean("desired_present").notNull(),
    customId: text("custom_id").notNull(),
    providerDocumentId: text("provider_document_id"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    leaseUntil: timestamp("lease_until", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    lastErrorCode: text("last_error_code"),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.scopeKey,
        table.recordIndex,
        table.revision,
      ],
    }),
    uniqueIndex("memory_sync_custom_id_idx").on(table.customId),
    index("memory_sync_ready_idx").on(
      table.status,
      table.nextAttemptAt,
      table.desiredPresent
    ),
    check("memory_sync_attempts_check", sql`${table.attempts} >= 0`),
  ]
);

/**
 * eve's file memory documents (`MemoryDocumentBackend`), one per eve scope
 * key. Bro's profile lives in `memory_records`; a document here is only the
 * old memory file a scope imports once. `version` is the compare-and-set
 * token a write must match.
 */
export const memoryDocuments = pgTable(
  "memory_documents",
  {
    scopeKey: text("scope_key").primaryKey(),
    content: text("content").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("memory_documents_version_check", sql`${table.version} > 0`),
  ]
);

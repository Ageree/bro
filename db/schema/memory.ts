import { sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  check,
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

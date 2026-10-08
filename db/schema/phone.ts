import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

const at = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    number: text("number").notNull(),
    state: text("state", {
      enum: [
        "quoted",
        "provisioning",
        "uncertain",
        "active",
        "disabled",
        "releasing",
        "operator-required",
        "released",
      ],
    }).notNull(),
    stage: text("stage", {
      enum: [
        "quoted",
        "buying",
        "owned",
        "sip-creating",
        "sip-ready",
        "importing",
        "imported",
        "outbound-importing",
        "outbound-imported",
        "forwarding",
        "ready",
      ],
    })
      .notNull()
      .default("quoted"),
    setupRub: integer("setup_rub").notNull(),
    monthlyRub: integer("monthly_rub").notNull(),
    sipMonthlyRub: integer("sip_monthly_rub").notNull(),
    quotedAt: at("quoted_at").notNull(),
    numberId: text("number_id"),
    sipId: text("sip_id"),
    phoneNumberId: text("phone_number_id"),
    outboundPhoneNumberId: text("outbound_phone_number_id"),
    agentId: text("agent_id"),
    sessionId: text("session_id"),
    conversationId: text("conversation_id"),
    conversationChannel: text("conversation_channel"),
    leaseToken: text("lease_token"),
    leaseUntil: at("lease_until"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("phone_numbers_workspace_unique").on(table.workspaceId),
    uniqueIndex("phone_numbers_number_unique").on(table.number),
    uniqueIndex("phone_numbers_provider_unique").on(table.phoneNumberId),
    uniqueIndex("phone_numbers_outbound_provider_unique").on(
      table.outboundPhoneNumberId
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("restrict"),
  ]
);

export const phoneCalls = pgTable(
  "phone_calls",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    numberRecordId: text("number_record_id").notNull(),
    operationId: text("operation_id").notNull(),
    inputHash: text("input_hash").notNull(),
    direction: text("direction", { enum: ["outbound", "inbound"] }).notNull(),
    target: text("target"),
    task: text("task"),
    state: text("state", {
      enum: [
        "planned",
        "starting",
        "accepted",
        "active",
        "processing",
        "done",
        "failed",
        "uncertain",
      ],
    }).notNull(),
    providerConversationId: text("provider_conversation_id"),
    durationSeconds: integer("duration_seconds"),
    costUsd: numeric("cost_usd"),
    carrierRub: numeric("carrier_rub"),
    outcome: text("outcome"),
    taskSucceeded: boolean("task_succeeded"),
    summary: text("summary"),
    sessionId: text("session_id"),
    conversationId: text("conversation_id"),
    conversationChannel: text("conversation_channel"),
    checkedAt: at("checked_at"),
    completedAt: at("completed_at"),
    reportDeliveredAt: at("report_delivered_at"),
    reportLeaseToken: text("report_lease_token"),
    reportLeaseUntil: at("report_lease_until"),
    reportAttempts: integer("report_attempts").notNull().default(0),
    reportStartedAt: at("report_started_at"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("phone_calls_operation_unique").on(table.operationId),
    uniqueIndex("phone_calls_conversation_unique").on(
      table.providerConversationId
    ),
    index("phone_calls_workspace_created").on(
      table.workspaceId,
      table.createdAt
    ),
    foreignKey({
      columns: [table.numberRecordId],
      foreignColumns: [phoneNumbers.id],
    }).onDelete("restrict"),
  ]
);

export const phoneEvents = pgTable("phone_events", {
  id: text("id").primaryKey(),
  providerConversationId: text("provider_conversation_id").notNull(),
  eventType: text("event_type").notNull(),
  receivedAt: at("received_at").notNull().defaultNow(),
  processedAt: at("processed_at"),
  metadata: jsonb("metadata").$type<{ timestamp: number }>().notNull(),
});

export const phoneNumberRequests = pgTable(
  "phone_number_requests",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    state: text("state", {
      enum: ["pending", "working", "retry", "complete", "operator-required"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: at("next_attempt_at").notNull().defaultNow(),
    leaseToken: text("lease_token"),
    leaseUntil: at("lease_until"),
    lastFailure: text("last_failure", {
      enum: ["preflight", "uncertain", "configuration", "capacity"],
    }),
    sessionId: text("session_id"),
    conversationId: text("conversation_id"),
    conversationChannel: text("conversation_channel"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("phone_number_requests_due").on(table.state, table.nextAttemptAt),
  ]
);

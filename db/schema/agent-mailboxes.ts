import { relations } from "drizzle-orm";
import {
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/** The persistent AgentMail inbox belonging to a workspace's Bro agent. */
export const agentMailboxes = pgTable(
  "agent_mailboxes",
  {
    workspaceId: text("workspace_id").primaryKey(),
    inboxId: text("inbox_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "agent_mailboxes_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    uniqueIndex("agent_mailboxes_inbox_id_uidx").on(table.inboxId),
  ]
);

export const agentMailboxesRelations = relations(agentMailboxes, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [agentMailboxes.workspaceId],
    references: [workspaces.id],
  }),
}));

/** Durable receipts stop workflow replays from delivering the same email twice. */
export const agentMailSends = pgTable(
  "agent_mail_sends",
  {
    workspaceId: text("workspace_id").notNull(),
    operationId: text("operation_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    messageId: text("message_id"),
    threadId: text("thread_id"),
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
      name: "agent_mail_sends_pkey",
      columns: [table.workspaceId, table.operationId],
    }),
    foreignKey({
      name: "agent_mail_sends_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
  ]
);

export const agentMailSendsRelations = relations(agentMailSends, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [agentMailSends.workspaceId],
    references: [workspaces.id],
  }),
}));

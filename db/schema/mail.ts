import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { workspaceMemberships } from "./workspaces";
import { mailAccessSchema, mailProviderSchema } from "@shared/mail/schema";

export const mailConnections = pgTable(
  "mail_connections",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    provider: text("provider", { enum: mailProviderSchema.options }).notNull(),
    access: text("access", { enum: mailAccessSchema.options }).notNull(),
    email: text("email").notNull(),
    encryptedTokens: text("encrypted_tokens").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.provider] }),
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "mail_connections_provider_check",
      sql`${table.provider} IN ('mailru', 'yandex')`
    ),
    check(
      "mail_connections_access_check",
      sql`${table.access} IN ('full', 'read_only')`
    ),
  ]
);

export const mailAuthorizations = pgTable(
  "mail_authorizations",
  {
    stateHash: text("state_hash").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    provider: text("provider", { enum: mailProviderSchema.options }).notNull(),
    access: text("access", { enum: mailAccessSchema.options }).notNull(),
    redirectUri: text("redirect_uri").notNull(),
    encryptedVerifier: text("encrypted_verifier").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "mail_authorizations_provider_check",
      sql`${table.provider} IN ('mailru', 'yandex')`
    ),
    check(
      "mail_authorizations_access_check",
      sql`${table.access} IN ('full', 'read_only')`
    ),
  ]
);

export const mailSends = pgTable(
  "mail_sends",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    provider: text("provider", { enum: mailProviderSchema.options }).notNull(),
    operationId: text("operation_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status", {
      enum: ["sending", "accepted", "uncertain"],
    }).notNull(),
    messageId: text("message_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.provider, table.operationId],
    }),
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "mail_sends_provider_check",
      sql`${table.provider} IN ('mailru', 'yandex')`
    ),
    check(
      "mail_sends_status_check",
      sql`${table.status} IN ('sending', 'accepted', 'uncertain')`
    ),
  ]
);

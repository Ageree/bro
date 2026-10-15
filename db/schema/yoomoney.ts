import { foreignKey, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { workspaceMemberships } from "./workspaces";

/**
 * The person's YooMoney wallet, one per workspace: its number and the OAuth
 * token Bro reads it with, encrypted with the installation's key
 * (`db/services/yoomoney.ts`). YooMoney's token lives three years and has
 * no refresh; `scope` is what the person granted.
 */
export const yoomoneyConnections = pgTable(
  "yoomoney_connections",
  {
    workspaceId: text("workspace_id").primaryKey(),
    userId: text("user_id").notNull(),
    account: text("account").notNull(),
    scope: text("scope").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
  ]
);

/**
 * A started consent: the hash of the state its Redirect URI carries, for
 * 15 minutes. YooMoney has no `state` of OAuth: the state rides in the
 * Redirect URI's query, which YooMoney keeps and the token request repeats.
 */
export const yoomoneyAuthorizations = pgTable(
  "yoomoney_authorizations",
  {
    stateHash: text("state_hash").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
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
  ]
);

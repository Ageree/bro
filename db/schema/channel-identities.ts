import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

/** Conversation channels a person can bind to their account after signing in. */
export const linkableChannels = ["telegram"] as const;

export const channelIdentities = pgTable(
  "channel_identities",
  {
    channel: text("channel", { enum: linkableChannels }).notNull(),
    externalUserId: text("external_user_id").notNull(),
    chatId: text("chat_id").notNull(),
    username: text("username"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    linkedAt: timestamp("linked_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.channel, table.externalUserId],
      name: "channel_identities_pkey",
    }),
    check(
      "channel_identities_channel_check",
      sql`${table.channel} IN ('telegram')`
    ),
    // One account owns at most one identity per channel, so a second Telegram
    // account cannot silently take over an existing conversation.
    uniqueIndex("channel_identities_account_idx").on(
      table.userId,
      table.channel
    ),
    index("channel_identities_workspace_idx").on(
      table.workspaceId,
      table.channel
    ),
  ]
);

export const channelLinkTokens = pgTable(
  "channel_link_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    channel: text("channel", { enum: linkableChannels }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    usedAt: timestamp("used_at", {
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
  },
  (table) => [
    check(
      "channel_link_tokens_channel_check",
      sql`${table.channel} IN ('telegram')`
    ),
    index("channel_link_tokens_expiry_idx").on(table.expiresAt),
  ]
);

export const channelIdentitiesRelations = relations(
  channelIdentities,
  ({ one }) => ({
    user: one(user, {
      fields: [channelIdentities.userId],
      references: [user.id],
    }),
  })
);

export const channelLinkTokensRelations = relations(
  channelLinkTokens,
  ({ one }) => ({
    user: one(user, {
      fields: [channelLinkTokens.userId],
      references: [user.id],
    }),
  })
);

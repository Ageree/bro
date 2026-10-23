import { sql } from "drizzle-orm";
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
import type { CardAnswer } from "@shared/cards/response";
import type { Card } from "@shared/cards/schema";
import { workspaceMemberships } from "./workspaces";

/**
 * A card Bro sent to a chat (`docs/cards.md`): one page of structured
 * information that Telegram opens as a Mini App from a button. The row's id
 * is the link's secret (`/card/<id>`, 32 random bytes), and `payload` is a
 * `cardSchema` value, checked before it is stored. Past `expiresAt` the
 * link opens nothing (`db/services/cards.ts`).
 *
 * `ref` is how Bro names the card to `update_card`: short, so the model
 * copies it whole, and no part of the secret. The chat it was sent to is
 * where the person's answer goes back and the only chat that may update
 * it; `revision` counts the updates, and an answer names the one it saw.
 * Cards sent before answers existed have no chat.
 */
export const cards = pgTable(
  "cards",
  {
    id: text("id").primaryKey(),
    ref: text("ref").notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    conversationChannel: text("conversation_channel", {
      enum: ["telegram"],
    }),
    conversationId: text("conversation_id"),
    payload: jsonb("payload").$type<Card>().notNull(),
    revision: integer("revision").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    index("cards_expires_at_idx").on(table.expiresAt),
    uniqueIndex("cards_ref_idx").on(table.ref),
    check(
      "cards_conversation_channel_check",
      sql`${table.conversationChannel} IN ('telegram')`
    ),
  ]
);

/**
 * The person's answer to a card (`shared/cards/response.ts`): the submit
 * button they pressed and what they chose and typed, checked against the
 * card at `revision`, `summary` as Bro reads it against that revision's
 * labels, and the Telegram user that proved it was them. One
 * answer per revision: pressing again, reloading the page or a lost
 * response finds the answer already kept.
 *
 * `state` is how far it got to Bro: `received` waits to become a turn of
 * the card's chat (`agent/lib/cards/answers.ts`), which claims it with
 * `claimedAt` and counts its `attempts`; `delivered` became one;
 * `failed` never will.
 */
export const cardResponses = pgTable(
  "card_responses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    values: jsonb("values").$type<CardAnswer["values"]>().notNull(),
    summary: text("summary").notNull(),
    telegramUserId: text("telegram_user_id").notNull(),
    state: text("state", { enum: ["received", "delivered", "failed"] })
      .default("received")
      .notNull(),
    attempts: integer("attempts").default(0).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
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
    uniqueIndex("card_responses_card_revision_idx").on(
      table.cardId,
      table.revision
    ),
    index("card_responses_received_idx")
      .on(table.createdAt)
      .where(sql`${table.state} = 'received'`),
    index("card_responses_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt
    ),
    check(
      "card_responses_state_check",
      sql`${table.state} IN ('received', 'delivered', 'failed')`
    ),
  ]
);

import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { Card } from "@shared/cards/schema";
import { workspaceMemberships } from "./workspaces";

/**
 * A card Bro sent to a chat (`docs/cards.md`): one page of structured
 * information that Telegram opens as a Mini App from a button. The row's id
 * is the link's secret (`/card/<id>`, 32 random bytes), and `payload` is a
 * `cardSchema` value, checked before it is stored. Past `expiresAt` the
 * link opens nothing (`db/services/cards.ts`).
 */
export const cards = pgTable(
  "cards",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    payload: jsonb("payload").$type<Card>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
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
    index("cards_expires_at_idx").on(table.expiresAt),
  ]
);

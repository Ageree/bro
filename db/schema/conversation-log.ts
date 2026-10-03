import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * What the person said in each chat, a line per message cut to 500
 * characters with one-time codes and card numbers cut out, so a
 * conversation in one channel can be told what was said in another
 * (`agent/lib/conversation/`). Only the person's lines: Bro's messages
 * quote mail, pages and task output, which another chat's recap, a
 * user-role context message, must not carry
 * (`agent/hooks/conversation-log.ts`). Written only for the pilot
 * (CROSS_CHANNEL_WORKSPACES); every line goes 14 days after it was said,
 * pilot or not (`expireConversationLines`), and every forget-all call takes
 * the workspace's lines at once. `turn_id` is the eve turn the
 * line opened: a re-run step emits its message again, and the unique index
 * keeps the line once.
 */
export const conversationLog = pgTable(
  "conversation_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    channel: text("channel").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("conversation_log_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc()
    ),
    index("conversation_log_created_idx").on(table.createdAt),
    uniqueIndex("conversation_log_turn_line_uidx").on(
      table.sessionId,
      table.turnId,
      sql`md5(${table.text})`
    ),
    check(
      "conversation_log_text_check",
      sql`char_length(${table.text}) BETWEEN 1 AND 500`
    ),
  ]
);

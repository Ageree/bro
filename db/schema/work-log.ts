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
 * What Bro did in each chat, so a new chat — /talk's voice opens one every
 * time — knows the work of the others (`agent/lib/work-log/`): the person's
 * requests, with the names of the files they sent, and every message Bro
 * delivered, a report of work handed off included, each cut to 2000
 * characters with one-time codes, card numbers and passwords cut out.
 * Written only for the pilot (WORK_LOG_WORKSPACES); every line goes 30 days
 * after it was said, pilot or not (`expireWorkLines`), and every forget-all
 * call takes the workspace's lines at once. `turn_id` is the eve turn the
 * line came in: a re-run step emits the same event again, and the unique
 * index keeps the line once.
 */
export const workLog = pgTable(
  "work_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    channel: text("channel").notNull(),
    role: text("role").notNull(),
    text: text("text").notNull(),
    files: text("files").array().notNull().default([]),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("work_log_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst()
    ),
    index("work_log_created_idx").on(table.createdAt),
    uniqueIndex("work_log_turn_line_uidx").on(
      table.sessionId,
      table.turnId,
      table.role,
      sql`md5(${table.text})`
    ),
    check("work_log_role_check", sql`${table.role} IN ('person', 'bro')`),
    check(
      "work_log_text_check",
      sql`char_length(${table.text}) BETWEEN 1 AND 2000`
    ),
  ]
);

import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const at = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

/**
 * A bug a person reported to the service bot (`agent/lib/bug-bot`). The Bot
 * API's `update_id` is unique, so a batch read twice files a report once.
 * `workspaceId` is null for a person with no linked account. `new`: filed,
 * not yet forwarded; `forwarded`: the owner has it (`forwardMessageId` is the
 * message in the owner's chat that a reply is matched against); `answered`:
 * the owner replied.
 */
export const bugReports = pgTable(
  "bug_reports",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    updateId: bigint("update_id", { mode: "number" }).notNull(),
    telegramUserId: text("telegram_user_id").notNull(),
    chatId: text("chat_id").notNull(),
    username: text("username"),
    firstName: text("first_name"),
    workspaceId: text("workspace_id"),
    text: text("text").notNull(),
    photoFileId: text("photo_file_id"),
    status: text("status", { enum: ["new", "forwarded", "answered"] })
      .notNull()
      .default("new"),
    forwardMessageId: bigint("forward_message_id", { mode: "number" }),
    createdAt: at("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("bug_reports_update_id_idx").on(table.updateId),
    index("bug_reports_user_created_idx").on(
      table.telegramUserId,
      table.createdAt
    ),
    index("bug_reports_forward_message_idx").on(table.forwardMessageId),
  ]
);

/** What the owner answered to a report, as sent to the person. */
export const bugReportReplies = pgTable(
  "bug_report_replies",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    reportId: integer("report_id")
      .notNull()
      .references(() => bugReports.id, { onDelete: "cascade" }),
    updateId: bigint("update_id", { mode: "number" }).notNull(),
    text: text("text").notNull(),
    createdAt: at("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("bug_report_replies_update_id_idx").on(table.updateId),
  ]
);

/** Where the bot's `getUpdates` reading stands: the next offset to ask for. */
export const bugBotState = pgTable("bug_bot_state", {
  id: text("id").primaryKey(),
  nextOffset: bigint("next_offset", { mode: "number" }).notNull(),
  pausedUntil: at("paused_until"),
  // One tick at a time: a second reader of getUpdates would get a 409.
  leaseUntil: at("lease_until"),
  // The update that keeps failing and how many times, so one poison update
  // is skipped after a few tries instead of blocking the queue.
  failedUpdateId: bigint("failed_update_id", { mode: "number" }),
  failedCount: integer("failed_count").notNull().default(0),
});

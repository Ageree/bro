import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per sign-in code sent, under each key it counts against: the phone
 * number and the client's address, both as SHA-256 so the table holds no
 * number in the clear. Codes go out by iMessage from Bro's own line, and a
 * flood to strangers' numbers would get the line blocked; web and eve are two
 * processes, so the counts live here rather than in memory. Rows older than a
 * day are deleted as new ones arrive (`db/services/auth/code-sends.ts`).
 */
export const signInCodeSends = pgTable(
  "sign_in_code_sends",
  {
    key: text("key").notNull(),
    sentAt: timestamp("sent_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
  },
  (table) => [index("sign_in_code_sends_key_idx").on(table.key, table.sentAt)]
);

import { numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per deployment-level alert the owner can receive, such as a low
 * model balance. It remembers when the alert last went out and what it said,
 * so a schedule that ticks every few minutes alerts on a change rather than on
 * every tick.
 */
export const operationalAlerts = pgTable("operational_alerts", {
  key: text("key").primaryKey(),
  lastSentAt: timestamp("last_sent_at", {
    mode: "date",
    precision: 3,
    withTimezone: true,
  }),
  lastValue: numeric("last_value", { mode: "number", precision: 16, scale: 8 }),
  updatedAt: timestamp("updated_at", {
    mode: "date",
    precision: 3,
    withTimezone: true,
  })
    .defaultNow()
    .notNull(),
});

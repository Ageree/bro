import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaceMemberships } from "./workspaces";

/**
 * A Yandex Go ride Bro booked and keeps an eye on
 * (`agent/lib/taxi/watch.ts`): the tick reads the ride from Yandex and tells
 * the person in the chat they asked in that a car is found, that it is time to
 * step out, and that it is there. Each `*ToldAt` says the person heard it;
 * the watch ends (`done`) when Yandex no longer lists the order, the car is
 * there, or `expiresAt` passes. `nextCheckAt` is also the claim of the tick
 * that reads it.
 */
export const taxiWatches = pgTable(
  "taxi_watches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    orderId: text("order_id").notNull(),
    // The ride for someone else: their car is told to them by Yandex, so the
    // person is told once it is found and no more.
    forPassenger: boolean("for_passenger").notNull().default(false),
    conversationChannel: text("conversation_channel", {
      enum: ["eve", "photon", "telegram"],
    }).notNull(),
    conversationId: text("conversation_id").notNull(),
    state: text("state", { enum: ["watching", "done"] })
      .notNull()
      .default("watching"),
    status: text("status"),
    car: text("car"),
    foundToldAt: timestamp("found_told_at", { withTimezone: true }),
    leaveToldAt: timestamp("leave_told_at", { withTimezone: true }),
    arrivedToldAt: timestamp("arrived_told_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
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
    uniqueIndex("taxi_watches_order_uidx").on(table.workspaceId, table.orderId),
    check(
      "taxi_watches_state_check",
      sql`${table.state} IN ('watching', 'done')`
    ),
  ]
);

import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * What Bro was told it may suggest to a workspace's person once a request
 * is done: one row per capability the person had not tried
 * (`agent/lib/capabilities/`), when it was last offered and how many times.
 * The newest `offered_at` of a workspace spaces the tips out; a capability
 * rests after an offer and stops being offered after a few. A row says the
 * tip reached the model, not that Bro said it or the person took it up.
 */
export const capabilityTips = pgTable(
  "capability_tips",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    offeredAt: timestamp("offered_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    offers: integer("offers").notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.capability] })]
);

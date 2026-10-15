import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * Where the person was, as they themselves shared it (`docs/location.md`): a
 * Telegram location or venue, an iMessage location card (`position`), or a
 * place they forwarded or pinned (`place`). Never from the model, a page, an
 * email or a link in text. Kept 90 days (`locationRetentionDays`).
 */
export const locationPoints = pgTable(
  "location_points",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    // `position`: where the person is; `place`: a place they talk about.
    kind: text("kind", { enum: ["position", "place"] }).notNull(),
    source: text("source", {
      enum: ["telegram", "telegram_venue", "telegram_live", "imessage", "web"],
    }).notNull(),
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    // Metres, as the device reported; null when it did not (a venue).
    accuracyM: integer("accuracy_m"),
    // The person's own name for it («парковка», «дом») or a venue's title.
    label: text("label"),
    // The short address (road, house, city), filled when first known.
    address: text("address"),
    recordedAt: timestamp("recorded_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    // A Telegram live share: `liveKeyOf(chat id, message id)`.
    liveKey: text("live_key"),
    // Redelivery guard: `telegram:<chat>:<message>:<edit_date|date>`,
    // `imessage:<message id>:<n>`. Unique per workspace.
    externalId: text("external_id").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    index("location_points_workspace_time_idx").on(
      table.workspaceId,
      table.recordedAt.desc()
    ),
    index("location_points_live_idx")
      .on(table.liveKey, table.recordedAt.desc())
      .where(sql`${table.liveKey} IS NOT NULL`),
    index("location_points_expiry_idx").on(table.recordedAt),
    uniqueIndex("location_points_external_uidx").on(
      table.workspaceId,
      table.externalId
    ),
    check(
      "location_points_kind_check",
      sql`${table.kind} IN ('position', 'place')`
    ),
    check(
      "location_points_source_check",
      sql`${table.source} IN ('telegram', 'telegram_venue', 'telegram_live', 'imessage', 'web')`
    ),
    check(
      "location_points_coordinates_check",
      sql`${table.lat} BETWEEN -90 AND 90 AND ${table.lon} BETWEEN -180 AND 180`
    ),
    check(
      "location_points_accuracy_check",
      sql`${table.accuracyM} IS NULL OR ${table.accuracyM} >= 0`
    ),
    check(
      "location_points_label_check",
      sql`${table.label} IS NULL OR length(${table.label}) BETWEEN 1 AND 80`
    ),
  ]
);

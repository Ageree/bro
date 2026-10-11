import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { z } from "zod";
import { workspaces } from "./workspaces";

export const yandexPurchases = pgTable(
  "yandex_purchases",
  {
    id: uuid("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    service: text("service", { enum: ["lavka", "go"] }).notNull(),
    checkoutKey: text("checkout_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency", { enum: ["RUB"] }).notNull(),
    state: text("state", {
      enum: ["quoted", "submitting", "placed", "rejected", "unknown", "active"],
    })
      .notNull()
      .default("quoted"),
    confirmationQuestion: text("confirmation_question").notNull(),
    publicQuote: jsonb("public_quote")
      .$type<Record<string, z.infer<ReturnType<typeof z.json>>>>()
      .notNull(),
    providerSnapshot: jsonb("provider_snapshot")
      .$type<Record<string, z.infer<ReturnType<typeof z.json>>>>()
      .notNull(),
    outcome:
      jsonb("outcome").$type<
        Record<string, z.infer<ReturnType<typeof z.json>>>
      >(),
    merchantOrderId: text("merchant_order_id"),
    callId: text("call_id"),
    phase: text("phase", {
      enum: ["draft_claimed", "drafted", "commit_claimed", "accepted"],
    }),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    submittedAt: timestamp("submitted_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
    settledAt: timestamp("settled_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
  },
  (table) => [
    foreignKey({
      name: "yandex_purchases_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    unique("yandex_purchases_fingerprint_uidx").on(
      table.workspaceId,
      table.service,
      table.fingerprint
    ),
    uniqueIndex("yandex_purchases_active_uidx")
      .on(table.workspaceId)
      .where(sql`${table.state} IN ('submitting', 'unknown', 'active')`),
    check(
      "yandex_purchases_service_check",
      sql`${table.service} IN ('lavka', 'go')`
    ),
    check("yandex_purchases_currency_check", sql`${table.currency} = 'RUB'`),
    check(
      "yandex_purchases_amount_check",
      sql`${table.amountMinor} BETWEEN 0 AND 9007199254740991`
    ),
    check(
      "yandex_purchases_state_check",
      sql`${table.state} IN ('quoted', 'submitting', 'placed', 'rejected', 'unknown', 'active')`
    ),
    check(
      "yandex_purchases_phase_check",
      sql`(${table.phase} IS NULL OR (${table.service} = 'go' AND ${table.phase} IN ('draft_claimed', 'drafted', 'commit_claimed', 'accepted'))) AND (${table.phase} NOT IN ('drafted', 'commit_claimed', 'accepted') OR ${table.merchantOrderId} IS NOT NULL) AND (${table.state} <> 'active' OR (${table.service} = 'go' AND ${table.phase} IS NOT NULL AND ${table.phase} = 'accepted' AND ${table.merchantOrderId} IS NOT NULL))`
    ),
    check(
      "yandex_purchases_attempt_check",
      sql`(${table.state} = 'quoted' AND ${table.callId} IS NULL AND ${table.submittedAt} IS NULL) OR (${table.state} <> 'quoted' AND ${table.callId} IS NOT NULL AND ${table.submittedAt} IS NOT NULL)`
    ),
  ]
);

export type YandexPurchase = typeof yandexPurchases.$inferSelect;

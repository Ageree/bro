import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaceMemberships } from "./workspaces";

/**
 * The person's YooMoney wallet, one per workspace: its number and the OAuth
 * token Bro reads it with, encrypted with the installation's key
 * (`db/services/yoomoney/connection.ts`). YooMoney's token lives three years and has
 * no refresh; `scope` is what the person granted.
 */
export const yoomoneyConnections = pgTable(
  "yoomoney_connections",
  {
    workspaceId: text("workspace_id").primaryKey(),
    userId: text("user_id").notNull(),
    account: text("account").notNull(),
    scope: text("scope").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
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
  ]
);

/**
 * A started consent: the hash of the state its Redirect URI carries, for
 * 15 minutes. YooMoney has no `state` of OAuth: the state rides in the
 * Redirect URI's query, which YooMoney keeps and the token request repeats.
 */
export const yoomoneyAuthorizations = pgTable(
  "yoomoney_authorizations",
  {
    stateHash: text("state_hash").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
  ]
);

/**
 * A payment from the wallet (`db/services/yoomoney/payments.ts`): checked by
 * `request-payment` (`requestId`, the exact `amountMinor` with the fee) and
 * asked about in `confirmationQuestion`; paid once the person said yes.
 * `submitting` is a payment sent to `process-payment`, `pending` one
 * YooMoney still processes, `unknown` one whose answer was lost: the same
 * `requestId` reads each back and never pays twice. One of those at a time
 * per workspace; `consentHash` (the question the person's yes answered,
 * per conversation) pays one payment only.
 */
export const yoomoneyPayments = pgTable(
  "yoomoney_payments",
  {
    id: uuid("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    rootSessionId: text("root_session_id").notNull(),
    kind: text("kind", { enum: ["transfer", "service"] }).notNull(),
    // The wallet the payment was prepared from: it is read back only there.
    account: text("account"),
    title: text("title").notNull(),
    requestParams: jsonb("request_params")
      .$type<Record<string, string>>()
      .notNull(),
    shown: jsonb("shown").$type<{ label: string; value: string }[]>().notNull(),
    requestId: text("request_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    // Always false: YooMoney's wallet API dropped its test payments.
    test: boolean("test").notNull(),
    state: text("state", {
      enum: ["quoted", "submitting", "pending", "unknown", "paid", "refused"],
    })
      .notNull()
      .default("quoted"),
    confirmationQuestion: text("confirmation_question").notNull(),
    consentHash: text("consent_hash"),
    paymentId: text("payment_id"),
    error: text("error"),
    callId: text("call_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    // One yes pays one payment: the claim stores the question it answered.
    uniqueIndex("yoomoney_payments_consent_uidx").on(
      table.workspaceId,
      table.consentHash
    ),
    uniqueIndex("yoomoney_payments_in_flight_uidx")
      .on(table.workspaceId)
      .where(sql`${table.state} IN ('submitting', 'pending', 'unknown')`),
    check(
      "yoomoney_payments_kind_check",
      sql`${table.kind} IN ('transfer', 'service')`
    ),
    check(
      "yoomoney_payments_state_check",
      sql`${table.state} IN ('quoted', 'submitting', 'pending', 'unknown', 'paid', 'refused')`
    ),
    check(
      "yoomoney_payments_amount_check",
      sql`${table.amountMinor} BETWEEN 0 AND 9007199254740991`
    ),
  ]
);

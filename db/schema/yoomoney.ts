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
 * Connecting the wallet from a chat (`db/services/yoomoney/onboarding.ts`):
 * the page Bro's link or button opens (`/yoomoney/<id>`), for 30 minutes.
 * The page is the person's once they prove it — the cabinet's session, or
 * Telegram's signed data of the chat's own user — and the device that did
 * keeps a cookie whose hash is `deviceHash`, which also stands for the
 * session at YooMoney's callback. `connectedAt` is the consent given here,
 * `readyAt` the page finished (a card linked, or skipped), `resumedAt` Bro
 * told in the chat the link was asked for in, where it carries on.
 */
export const yoomoneyOnboardings = pgTable(
  "yoomoney_onboardings",
  {
    id: uuid("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    conversationChannel: text("conversation_channel", {
      enum: ["eve", "photon", "telegram"],
    }).notNull(),
    conversationId: text("conversation_id").notNull(),
    deviceHash: text("device_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete("cascade"),
    check(
      "yoomoney_onboardings_conversation_channel_check",
      sql`${table.conversationChannel} IN ('eve', 'photon', 'telegram')`
    ),
  ]
);

/**
 * A started consent: the hash of the state its Redirect URI carries, for
 * 15 minutes. YooMoney has no `state` of OAuth: the state rides in the
 * Redirect URI's query, which YooMoney keeps and the token request repeats.
 * One started on an onboarding's page names it: its device stands for the
 * cabinet's session at the callback.
 */
export const yoomoneyAuthorizations = pgTable(
  "yoomoney_authorizations",
  {
    stateHash: text("state_hash").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    onboardingId: uuid("onboarding_id").references(
      () => yoomoneyOnboardings.id,
      { onDelete: "cascade" }
    ),
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
 * per conversation) pays one payment only. A payment with `cardId` is paid
 * from the wallet's linked card (`db/services/yoomoney/card.ts`): after the
 * yes in the chat, or on its own page when YooMoney wants the card's CVV.
 * A payment that settles where Bro did not see it (its page, the bank, the
 * tick that reads payments in flight back) is told in the conversation it
 * was asked in (`conversationChannel`, `conversationId`); `outcomeToldAt`
 * says the person has heard how it went, from Bro or that notice.
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
    // The linked card it is paid from (YooMoney's card id), as the person
    // sees it («••4310»), and whether YooMoney wants its CVV.
    cardId: text("card_id"),
    cardLabel: text("card_label"),
    cscRequired: boolean("csc_required"),
    // A card payment waiting for the person on their bank's 3-D Secure
    // page: the form YooMoney gave to POST there (no card data in it).
    bankUri: text("bank_uri"),
    bankParams: jsonb("bank_params").$type<Record<string, string>>(),
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
    // Where the person asked for it; null on payments made before it was kept.
    conversationChannel: text("conversation_channel", {
      enum: ["eve", "photon", "telegram"],
    }),
    conversationId: text("conversation_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    outcomeToldAt: timestamp("outcome_told_at", { withTimezone: true }),
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
    check(
      "yoomoney_payments_conversation_channel_check",
      sql`${table.conversationChannel} IN ('eve', 'photon', 'telegram')`
    ),
  ]
);

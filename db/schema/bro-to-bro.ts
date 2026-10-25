import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  broCalendarStates,
  broLinkStatuses,
  broReportKinds,
  broSides,
  broThreadStatuses,
  envoyActions,
  type BroCalendarState,
  type BroInviteChannel,
  type BroMandate,
  type BroProposal,
  type EnvoyAction,
} from "@shared/bro-to-bro/contract";
import { workspaces } from "./workspaces";

const at = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

/** A check constraint's value list, taken from the contract's constants. */
const oneOf = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

const broReportStatuses = [
  "pending",
  "leased",
  "delivered",
  "dropped",
] as const;

/**
 * Where a side's reports go: the conversation its owner started the thread
 * from, as `agent/lib/phone/route.ts` names one.
 */
export interface BroReportTarget {
  readonly conversationChannel: "eve" | "photon" | "telegram";
  readonly conversationId: string;
  readonly sessionId: string;
}

/** An envoy's question to its own owner. */
export interface BroOwnerQuestion {
  readonly id: string;
  readonly at: string;
  readonly text: string;
}

/**
 * An owner's answer to their envoy: context the envoy decides with, not
 * permission to repeat it to the peer.
 */
export interface BroOwnerAnswer {
  readonly id: string;
  readonly at: string;
  readonly text: string;
}

/** One message an envoy says to the peer: the package the gate checks. */
export interface BroEnvoyPackage {
  readonly action: Exclude<EnvoyAction, "ask_owner">;
  readonly body: string;
  /** A `propose`: the proposal the message makes. */
  readonly proposal?: BroProposal;
  /** An `accept`: the peer's `propose` message it agrees to. */
  readonly acceptsMessageId?: string;
}

/**
 * A package the gate held. It never changes: the owner approves this id, and
 * then exactly this package goes out; anything else is a new draft.
 */
export interface BroHeldMessage extends BroEnvoyPackage {
  readonly id: string;
  readonly at: string;
  readonly reason: string;
  readonly approved: boolean;
}

/**
 * What a report tells its owner. Every report names the peer; the other
 * fields belong to the kinds noted beside them.
 */
export interface BroReportPayload {
  /** The peer's name, when they have one. */
  readonly peerName: string | null;
  /** How this owner calls the peer, their own private note. */
  readonly peerLabel: string | null;
  /** invite_accepted: who accepted, for the inviter to recognize them. */
  readonly telegramUsername?: string | null;
  /** invite_accepted: where they said yes. */
  readonly channel?: BroInviteChannel | null;
  /** invite_accepted: whole days since their account was made, if known. */
  readonly accountDays?: number | null;
  /** invite_accepted, link_ready, link_removed: this owner's own link row. */
  readonly linkId?: string;
  /** Thread reports: what the thread is about, as both sides see it. */
  readonly topic?: string | null;
  /** question */
  readonly questionId?: string;
  /** held */
  readonly draftId?: string;
  /** held: what the held package does besides its words. */
  readonly action?: BroEnvoyPackage["action"];
  /** agreed, confirmed */
  readonly proposalId?: string;
  /**
   * agreed, confirmed; held: the proposal the held package makes; question:
   * the peer's open proposal, if the latest one is theirs.
   */
  readonly proposal?: BroProposal;
  /** confirmed: what became of the meeting in this owner's own calendar. */
  readonly calendar?: Exclude<BroCalendarState, "pending">;
  /** question, held, answered, declined; agreed: the words the peer's yes came with. */
  readonly text?: string | null;
  /** held: why the gate held the draft. */
  readonly reason?: string;
  /** declined, cancelled: whose side closed the thread. */
  readonly by?: "self" | "peer";
  /** alert: what the peer's envoy tried to learn in one step. */
  readonly alerts?: readonly {
    readonly category: string;
    readonly request: string;
  }[];
}

/**
 * An invite to link Bros. The link carries a random token whose SHA-256 is
 * all that is stored; opening the link only records who opened it, and the
 * person who opened it accepts it with their own yes.
 */
export const broInvites = pgTable(
  "bro_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    inviterWorkspaceId: text("inviter_workspace_id").notNull(),
    inviterUserId: text("inviter_user_id").notNull(),
    // How the inviter calls the person invited; it becomes the inviter's
    // private label of the link.
    label: text("label"),
    expiresAt: at("expires_at").notNull(),
    // The last account that opened the link, and when.
    openedByWorkspaceId: text("opened_by_workspace_id"),
    openedAt: at("opened_at"),
    redeemedAt: at("redeemed_at"),
    redeemedByWorkspaceId: text("redeemed_by_workspace_id"),
    createdAt: at("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "bro_invites_inviter_workspace_id_fkey",
      columns: [table.inviterWorkspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "bro_invites_opened_by_workspace_id_fkey",
      columns: [table.openedByWorkspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("set null"),
    uniqueIndex("bro_invites_token_hash_uidx").on(table.tokenHash),
    index("bro_invites_inviter_created_idx").on(
      table.inviterWorkspaceId,
      table.createdAt
    ),
    index("bro_invites_opened_idx").on(
      table.openedByWorkspaceId,
      table.openedAt
    ),
    check("bro_invites_label_check", sql`char_length(${table.label}) <= 200`),
  ]
);

/**
 * One direction of a link between two people's Bros: what the owner of the
 * row opens to the peer. Both rows are written when an invite is accepted,
 * stay `pending` until the inviter confirms who accepted, and are marked
 * removed rather than deleted.
 */
export const broLinks = pgTable(
  "bro_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    peerWorkspaceId: text("peer_workspace_id").notNull(),
    peerUserId: text("peer_user_id").notNull(),
    // The invite both rows came from: its inviter confirms the link.
    inviteId: uuid("invite_id").notNull(),
    status: text("status", { enum: broLinkStatuses })
      .notNull()
      .default("pending"),
    // The peer's envoy may be offered times from this owner's calendar.
    calendar: boolean("calendar").notNull().default(true),
    // What this owner allows their envoy to tell the peer.
    shareNotes: text("share_notes"),
    // How this owner calls the peer («брат»): never shown to the peer or to
    // an envoy.
    peerLabel: text("peer_label"),
    // Grows with every change of what is open (status, calendar, notes): an
    // envoy step built on an older revision is discarded.
    revision: integer("revision").notNull().default(0),
    createdAt: at("created_at").defaultNow().notNull(),
    updatedAt: at("updated_at").defaultNow().notNull(),
    removedAt: at("removed_at"),
  },
  (table) => [
    foreignKey({
      name: "bro_links_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "bro_links_peer_workspace_id_fkey",
      columns: [table.peerWorkspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "bro_links_invite_id_fkey",
      columns: [table.inviteId],
      foreignColumns: [broInvites.id],
    }).onDelete("cascade"),
    uniqueIndex("bro_links_live_pair_uidx")
      .on(table.workspaceId, table.peerWorkspaceId)
      .where(sql`${table.removedAt} IS NULL`),
    check(
      "bro_links_status_check",
      sql`${table.status} IN (${oneOf(broLinkStatuses)})`
    ),
    check(
      "bro_links_pair_check",
      sql`${table.workspaceId} <> ${table.peerWorkspaceId}`
    ),
    check(
      "bro_links_share_notes_check",
      sql`char_length(${table.shareNotes}) <= 2000`
    ),
    check(
      "bro_links_peer_label_check",
      sql`char_length(${table.peerLabel}) <= 200`
    ),
  ]
);

/**
 * One errand between two linked people: the initiator's owner asked for
 * something, and the two envoys take turns until the thread closes.
 */
export const broThreads = pgTable(
  "bro_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    initiatorWorkspaceId: text("initiator_workspace_id").notNull(),
    responderWorkspaceId: text("responder_workspace_id").notNull(),
    // What both sides see the thread is about: taken from the first message
    // that passed the gate, never from the mandate.
    topic: text("topic"),
    status: text("status", { enum: broThreadStatuses })
      .notNull()
      .default("negotiating"),
    // Whose envoy speaks next and when; null while no envoy has a move.
    nextSide: text("next_side", { enum: broSides }),
    nextAt: at("next_at"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: at("lease_expires_at"),
    // The `propose` message both sides agreed to.
    agreedProposalId: uuid("agreed_proposal_id"),
    // Grows with every change: an envoy step built on an older version is
    // discarded.
    version: integer("version").notNull().default(0),
    envoyMessages: integer("envoy_messages").notNull().default(0),
    // Envoy steps that failed in a row: the model, the gate, a decision the
    // code refused.
    failedSteps: integer("failed_steps").notNull().default(0),
    deadlineAt: at("deadline_at").notNull(),
    createdAt: at("created_at").defaultNow().notNull(),
    updatedAt: at("updated_at").defaultNow().notNull(),
    closedAt: at("closed_at"),
  },
  (table) => [
    foreignKey({
      name: "bro_threads_initiator_workspace_id_fkey",
      columns: [table.initiatorWorkspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "bro_threads_responder_workspace_id_fkey",
      columns: [table.responderWorkspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    index("bro_threads_due_idx")
      .on(table.nextAt)
      .where(sql`${table.status} = 'negotiating'`),
    index("bro_threads_deadline_idx")
      .on(table.deadlineAt)
      .where(sql`${table.status} IN ('negotiating', 'agreed')`),
    index("bro_threads_pair_created_idx").on(
      table.initiatorWorkspaceId,
      table.responderWorkspaceId,
      table.createdAt
    ),
    index("bro_threads_closed_idx")
      .on(table.closedAt)
      .where(sql`${table.closedAt} IS NOT NULL`),
    check(
      "bro_threads_status_check",
      sql`${table.status} IN (${oneOf(broThreadStatuses)})`
    ),
    check(
      "bro_threads_next_side_check",
      sql`${table.nextSide} IN (${oneOf(broSides)})`
    ),
    check(
      "bro_threads_pair_check",
      sql`${table.initiatorWorkspaceId} <> ${table.responderWorkspaceId}`
    ),
    check(
      "bro_threads_closed_check",
      sql`(${table.closedAt} IS NULL) = (${table.status} IN ('negotiating', 'agreed'))`
    ),
  ]
);

/**
 * One side of a thread. Everything here is private to its own side: the
 * other side reads only whether this one confirmed or declined.
 */
export const broThreadSides = pgTable(
  "bro_thread_sides",
  {
    threadId: uuid("thread_id").notNull(),
    side: text("side", { enum: broSides }).notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    // What the initiator's owner asked for; the responder has none.
    mandate: jsonb("mandate").$type<BroMandate>(),
    ownerAnswers: jsonb("owner_answers")
      .$type<readonly BroOwnerAnswer[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // The envoy waits for its owner (a question, a held draft): the thread
    // does not move meanwhile.
    waitingOwner: boolean("waiting_owner").notNull().default(false),
    pendingQuestion: jsonb("pending_question").$type<BroOwnerQuestion>(),
    heldMessage: jsonb("held_message").$type<BroHeldMessage>(),
    confirmedProposalId: uuid("confirmed_proposal_id"),
    confirmedAt: at("confirmed_at"),
    declinedAt: at("declined_at"),
    // Categories this owner was already alerted about in this thread.
    alertedCategories: text("alerted_categories").array().notNull().default([]),
    // Null: reports go to the owner's remembered messenger.
    reportTarget: jsonb("report_target").$type<BroReportTarget>(),
    // The confirmed meeting in this owner's own calendar: null until both
    // owners said yes, then pending until Bro tried to put it there.
    calendarState: text("calendar_state", { enum: broCalendarStates }),
    calendarEventId: text("calendar_event_id"),
    calendarAttempts: integer("calendar_attempts").notNull().default(0),
    // When the next try may start: the lease of a try under way, or the
    // pause after a failed one.
    calendarNextAt: at("calendar_next_at"),
  },
  (table) => [
    primaryKey({
      name: "bro_thread_sides_pkey",
      columns: [table.threadId, table.side],
    }),
    foreignKey({
      name: "bro_thread_sides_thread_id_fkey",
      columns: [table.threadId],
      foreignColumns: [broThreads.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "bro_thread_sides_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    index("bro_thread_sides_workspace_idx").on(table.workspaceId),
    index("bro_thread_sides_calendar_due_idx")
      .on(table.calendarNextAt)
      .where(sql`${table.calendarState} = 'pending'`),
    check(
      "bro_thread_sides_side_check",
      sql`${table.side} IN (${oneOf(broSides)})`
    ),
    check(
      "bro_thread_sides_mandate_check",
      sql`${table.mandate} IS NULL OR ${table.side} = 'initiator'`
    ),
    check(
      "bro_thread_sides_calendar_state_check",
      sql`${table.calendarState} IN (${oneOf(broCalendarStates)})`
    ),
  ]
);

/**
 * What an envoy actually said to the peer, after the gate. A `propose`
 * message is the proposal itself, immutable, and its id is what the other
 * side accepts and both owners confirm.
 */
export const broMessages = pgTable(
  "bro_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id").notNull(),
    seq: integer("seq").notNull(),
    side: text("side", { enum: broSides }).notNull(),
    action: text("action", { enum: envoyActions }).notNull(),
    body: text("body").notNull(),
    proposal: jsonb("proposal").$type<BroProposal>(),
    // An `accept`: the peer's `propose` message. No foreign key: messages
    // past retention are deleted oldest first.
    acceptsMessageId: uuid("accepts_message_id"),
    // The gate held this exact text and the owner let it go.
    approvedByOwner: boolean("approved_by_owner").notNull().default(false),
    createdAt: at("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "bro_messages_thread_id_fkey",
      columns: [table.threadId],
      foreignColumns: [broThreads.id],
    }).onDelete("cascade"),
    uniqueIndex("bro_messages_thread_seq_uidx").on(table.threadId, table.seq),
    index("bro_messages_created_idx").on(table.createdAt),
    check(
      "bro_messages_side_check",
      sql`${table.side} IN (${oneOf(broSides)})`
    ),
    check(
      "bro_messages_action_check",
      sql`${table.action} IN (${oneOf(envoyActions)})`
    ),
    check(
      "bro_messages_proposal_check",
      sql`(${table.action} = 'propose') = (${table.proposal} IS NOT NULL)`
    ),
  ]
);

/**
 * The outbox of what Bro tells an owner about their links and threads. The
 * dedupe key names the event, so a repeated tick never reports it twice.
 */
export const broReports = pgTable(
  "bro_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    threadId: uuid("thread_id"),
    kind: text("kind", { enum: broReportKinds }).notNull(),
    payload: jsonb("payload").$type<BroReportPayload>().notNull(),
    // The side's report target when it has one; null, the owner's
    // remembered messenger.
    target: jsonb("target").$type<BroReportTarget>(),
    status: text("status", { enum: broReportStatuses })
      .notNull()
      .default("pending"),
    // One token for the life of the report, as a phone report's: a turn that
    // waited in the conversation's queue past the lease still settles it.
    leaseToken: text("lease_token"),
    // Nobody claims the report before this: the live lease, or the pause
    // after a failed attempt.
    leaseExpiresAt: at("lease_expires_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: at("created_at").defaultNow().notNull(),
    deliveredAt: at("delivered_at"),
  },
  (table) => [
    foreignKey({
      name: "bro_reports_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "bro_reports_thread_id_fkey",
      columns: [table.threadId],
      foreignColumns: [broThreads.id],
    }).onDelete("set null"),
    uniqueIndex("bro_reports_dedupe_key_uidx").on(table.dedupeKey),
    index("bro_reports_due_idx")
      .on(table.createdAt)
      .where(sql`${table.status} IN ('pending', 'leased')`),
    check(
      "bro_reports_kind_check",
      sql`${table.kind} IN (${oneOf(broReportKinds)})`
    ),
    check(
      "bro_reports_status_check",
      sql`${table.status} IN (${oneOf(broReportStatuses)})`
    ),
  ]
);

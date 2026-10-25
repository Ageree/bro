import * as z from "zod";

/**
 * The contract of Bro ↔ Bro (docs/bro-to-bro.md) that the database, the
 * agent and the cabinet share: where a link and a thread stand, what an
 * envoy may do, and what is reported to an owner.
 */

/** A link is pending until the inviter confirms who accepted it. */
export const broLinkStatuses = ["pending", "active"] as const;

/** Where the person invited said yes: their Bro in Telegram or iMessage, or the cabinet. */
export type BroInviteChannel = "imessage" | "telegram" | "web";

export const broSides = ["initiator", "responder"] as const;
export type BroSide = (typeof broSides)[number];

export const broThreadStatuses = [
  "negotiating",
  "agreed",
  "confirmed",
  "answered",
  "declined",
  "cancelled",
  "expired",
  "stalled",
] as const;
export type BroThreadStatus = (typeof broThreadStatuses)[number];

/** Statuses a thread never leaves. */
export const broClosedThreadStatuses = [
  "confirmed",
  "answered",
  "declined",
  "cancelled",
  "expired",
  "stalled",
] as const satisfies readonly BroThreadStatus[];

export const envoyActions = [
  "message",
  "propose",
  "accept",
  "decline",
  "ask_owner",
  "close",
] as const;
export type EnvoyAction = (typeof envoyActions)[number];

/** A point of an agreement, one line: who does or brings what. */
const broItemSchema = z.string().trim().min(1).max(200);

/** A sum an agreement is about, in whole roubles. */
const broAmountSchema = z.int().min(1).max(10_000_000);

/**
 * What an envoy proposes: a meeting (a time, a place), or any agreement —
 * its points (`items`, «Савелий — мясо и угли») and a sum (`amountRub`) are
 * the second version's (docs/bro-to-bro.md, «Не только встречи»).
 */
export const broProposalSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  start: z.iso.datetime({ offset: true }).optional(),
  end: z.iso.datetime({ offset: true }).optional(),
  place: z.string().trim().min(1).max(200).optional(),
  items: z.array(broItemSchema).max(20).optional(),
  amountRub: broAmountSchema.optional(),
});
export type BroProposal = z.infer<typeof broProposalSchema>;

/**
 * What the initiator's owner asked for, private to the initiator's side.
 * `details` is context the envoy decides with, never permission to say it.
 */
export const broMandateSchema = z.object({
  goal: z.string().trim().min(1).max(1000),
  details: z.string().trim().min(1).max(2000).nullable(),
  window: z
    .object({
      from: z.iso.datetime({ offset: true }),
      to: z.iso.datetime({ offset: true }),
    })
    .nullable(),
  durationMinutes: z
    .int()
    .min(15)
    .max(24 * 60)
    .nullable(),
  /**
   * The second version's: what the owner named for the errand — an exact
   * start, a venue, the points, a sum — as `bro_talk start` passed it, and
   * which of it code found in the owner's own words (`ownerSaid`). Only
   * what code found may go without asking; the rest is context.
   */
  at: z.iso.datetime({ offset: true }).nullish(),
  place: z.string().trim().min(1).max(200).nullish(),
  items: z.array(broItemSchema).max(20).nullish(),
  amountRub: broAmountSchema.nullish(),
  ownerSaid: z
    .object({
      time: z.boolean(),
      place: z.boolean(),
      amount: z.boolean(),
      /** What the owner said they pay for: each part of their words with their word of paying («скинемся маме на подарок»). */
      paysFor: z.array(z.string().trim().max(200)).max(10),
      /** What the owner said someone else pays for («а купит пусть Савелий»). */
      peerPays: z.array(z.string().trim().max(200)).max(10).optional(),
      /** Every point of `items` is in the owner's words. */
      items: z.boolean().optional(),
      /**
       * The longest the meeting may run without the owner confirming it, in
       * minutes: the shortest of what their words name, the errand's length
       * and, for an exact start, two hours. Absent, the owner's window alone
       * bounds it.
       */
      longest: z.number().int().min(1).max(1440).optional(),
    })
    .nullish(),
});
export type BroMandate = z.infer<typeof broMandateSchema>;

/**
 * Where a confirmed meeting stands in one owner's own calendar. Their yes to
 * the meeting is their yes to the calendar: once both owners said it, Bro
 * puts the meeting there by itself (`pending` until it tried), or says why
 * it did not.
 */
export const broCalendarStates = [
  "pending",
  "created",
  "skipped_no_calendar",
  "skipped_read_only",
  "skipped_no_time",
  "failed",
] as const;
export type BroCalendarState = (typeof broCalendarStates)[number];

export const broReportKinds = [
  "invite_accepted",
  "link_ready",
  "question",
  "held",
  "agreed",
  "confirmed",
  "declined",
  "answered",
  "alert",
  "expired",
  "stalled",
  "cancelled",
  "link_removed",
  "peer_unreachable",
] as const;
export type BroReportKind = (typeof broReportKinds)[number];

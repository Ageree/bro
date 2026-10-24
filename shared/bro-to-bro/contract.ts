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

export const broProposalSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  start: z.iso.datetime({ offset: true }).optional(),
  end: z.iso.datetime({ offset: true }).optional(),
  place: z.string().trim().min(1).max(200).optional(),
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
] as const;
export type BroReportKind = (typeof broReportKinds)[number];

import * as z from "zod";
import {
  type BroMandate,
  type BroProposal,
  type BroSide,
  type EnvoyAction,
  broProposalSchema,
  envoyActions,
} from "@shared/bro-to-bro/contract";
import type { ownerSetOf } from "@shared/bro-to-bro/owner-set";

/**
 * Everything one envoy step sees (docs/bro-to-bro.md, «Посол: вход и
 * выход»). The prompt is built from these fields alone, so what is not here
 * — memory, mail, the profile past a name and a zone, other threads — the
 * envoy cannot give away.
 */
export interface EnvoyBrief {
  readonly role: BroSide;
  readonly self: { readonly name: string; readonly timeZone: string };
  readonly peer: { readonly name: string };
  readonly shareNotes: string | null;
  /** The initiator's from its mandate, the responder's the topic of the peer's first message. */
  readonly goal: string;
  /** The initiator's only: context to decide with, never permission to say it. */
  readonly mandate: BroMandate | null;
  /** How long the meeting is (`meetingMinutes`); null while nobody named it. */
  readonly durationMinutes: number | null;
  readonly ownerAnswers: readonly {
    readonly id: string;
    readonly at: string;
    readonly text: string;
    /** The second version's, for code alone: the answer's own sums, and the proposal its plain yes was to. */
    readonly amountsRub?: readonly number[];
    readonly yesTo?: string;
  }[];
  readonly slots:
    | { readonly state: "not_granted" | "unavailable" }
    | {
        readonly state: "known";
        readonly candidates: readonly {
          readonly start: string;
          readonly end: string;
        }[];
      };
  readonly transcript: readonly {
    readonly id: string;
    readonly from: "self" | "peer";
    readonly at: string;
    readonly action: EnvoyAction;
    readonly text: string;
    readonly proposal?: BroProposal;
  }[];
  /** The proposal this side already agreed to (its id), if any. */
  readonly openProposalId: string | null;
  /**
   * The latest a time of the peer's may end for the envoy to answer it from
   * the calendar: the end of the window the side reads. Past it the owner is
   * asked.
   */
  readonly horizon: string;
  readonly messagesLeft: number;
  readonly now: string;
  /**
   * The second version's (docs/bro-to-bro.md, «Вторая версия»): its rules,
   * and, for the initiator, what its owner set for the errand — the time,
   * venue and sum code found in the owner's own words, which the envoy
   * offers as they are, and the points of the errand; what code did not
   * find there stays context. Absent, the envoy is the first version's.
   */
  readonly v2?: {
    readonly ownerSet: ReturnType<typeof ownerSetOf>;
  };
}

/**
 * What the envoy decided, as the model answered it: `message` goes to the
 * peer (optional only for `ask_owner`), `proposal` with `propose`,
 * `acceptProposalId` with `accept`, `ownerQuestion` with `ask_owner`,
 * and every closed request of the peer in `outOfScope`. The schema checks
 * the shape; `planEnvoyStep` checks the rest against the brief.
 */
export const envoyDecisionSchema = z
  .object({
    action: z.enum(envoyActions),
    message: z.string().trim().max(600).optional(),
    proposal: broProposalSchema.optional(),
    acceptProposalId: z.string().trim().min(1).optional(),
    ownerQuestion: z.string().trim().max(500).optional(),
    outOfScope: z
      .array(
        z.object({
          category: z.string().trim().min(1).max(60),
          request: z.string().trim().min(1).max(300),
        })
      )
      .max(10)
      .readonly()
      .default([]),
  })
  .readonly();
export type EnvoyDecision = z.output<typeof envoyDecisionSchema>;

/**
 * How long the meeting is, in minutes: what the initiator's owner asked for,
 * else the length of the thread's first proposal with a time. The responder
 * has no mandate, and without this its envoy offered and its calendar was
 * read for an hour while the initiator wanted two.
 */
export function meetingMinutes(
  mandate: BroMandate | null,
  messages: readonly { readonly proposal?: BroProposal | null }[]
) {
  if (mandate?.durationMinutes) return mandate.durationMinutes;
  const timed = messages.find(
    (message) => message.proposal?.start && message.proposal.end
  )?.proposal;
  if (!timed?.start || !timed.end) return null;
  return Math.round((Date.parse(timed.end) - Date.parse(timed.start)) / 60_000);
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** The weekday, date and time of an instant on the owner's clock. */
function wallClock(at: string, timeZone: string) {
  let format = clocks.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone,
      weekday: "short",
    });
    clocks.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((each) => each.type === type)?.value ?? "";
  return {
    date: `${part("weekday")} ${part("day")}.${part("month")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

/** «пт 23.10, 12:00»: an instant as the owner's clock shows it. */
export function momentLabel(at: string, timeZone: string) {
  const { date, time } = wallClock(at, timeZone);
  return `${date}, ${time}`;
}

/**
 * «сб 25.10, 19:00–23:00»: a span as the owner's clock shows it, for the
 * models that read the slots and proposals — they get the day of the week
 * right from it, not from an ISO string.
 */
export function spanLabel(start: string, end: string, timeZone: string) {
  const from = wallClock(start, timeZone);
  const to = wallClock(end, timeZone);
  if (from.date === to.date) return `${from.date}, ${from.time}–${to.time}`;
  return `${from.date}, ${from.time} – ${to.date}, ${to.time}`;
}

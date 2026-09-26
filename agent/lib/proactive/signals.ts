import type { z } from "zod";
import type { calendarEventListSchema } from "@agent/lib/google-workspace/calendar";
import { localMinuteOfDay } from "@agent/lib/proactive/quiet-hours";
import { urgentHandoverMarker } from "@agent/lib/schedules/outcome";
import type { ProactiveSignal } from "@db/services/proactive";
import type { UserProfile } from "@shared/user-profile/schema";

/** How far ahead a check looks for events: tomorrow's flight plus slack. */
export const calendarHorizonMs = 26 * 60 * 60_000;
/** Mail may arrive a little after its date; checks overlap by this much. */
const mailOverlapMs = 10 * 60_000;
/** Mail older than a day is not news, however long the checks paused. */
const mailLookbackLimitMs = 24 * 60 * 60_000;
/**
 * One run reads at most this many items. After a pause this bounds the single
 * catch-up run: older mail past the cap is skipped rather than drained in
 * batches. Events past the cap come back on the next check.
 */
const maxSignalsPerRun = 12;

/** Where the next mail search starts, given the stored watermark. */
export function mailSearchStart(mailCheckedAt: Date, now: Date) {
  return new Date(
    Math.max(
      mailCheckedAt.getTime() - mailOverlapMs,
      now.getTime() - mailLookbackLimitMs
    )
  );
}

/**
 * Inbox mail since `after`, without promotions, social notifications, mailing
 * lists and the person's own messages. Package and check-in notices sit in
 * Updates, so Updates stays.
 */
export function gmailProbeQuery(after: Date) {
  return `in:inbox after:${String(Math.floor(after.getTime() / 1_000))} -category:promotions -category:social -category:forums -from:me`;
}

export function gmailSignals(
  messages: readonly {
    readonly id?: string | null;
    readonly threadId?: string | null;
  }[]
) {
  return messages.flatMap(({ id, threadId }): ProactiveSignal[] =>
    id
      ? [
          {
            dedupeKey: id,
            itemId: id,
            source: "gmail",
            threadId: threadId ?? id,
          },
        ]
      : []
  );
}

const localDateFormatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` of `now` on the person's own calendar. */
function localDate(now: Date, timeZone: string) {
  let formatter = localDateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    });
    localDateFormatters.set(timeZone, formatter);
  }
  return formatter.format(now);
}

/**
 * Events that have not started yet. The key carries the start, so an event
 * moved to another time counts as new; a cancelled one is nothing to act on.
 * An all-day event has only a date, so it counts as started from that day on
 * in the person's zone: today's holiday or a trip already under way is not new.
 */
export function calendarSignals(
  events: readonly {
    readonly id?: string | null;
    readonly start?: {
      readonly date?: string | null;
      readonly dateTime?: string | null;
    } | null;
    readonly status?: string | null;
  }[],
  now: Date,
  timeZone: string
) {
  const today = localDate(now, timeZone);
  return events.flatMap((event): ProactiveSignal[] => {
    const start = event.start?.dateTime ?? event.start?.date;
    if (!event.id || !start || event.status === "cancelled") return [];
    const started = event.start?.dateTime
      ? Date.parse(start) < now.getTime()
      : start <= today;
    if (started) return [];
    return [
      {
        dedupeKey: `${event.id}@${start}`,
        itemId: event.id,
        source: "calendar",
        threadId: null,
      },
    ];
  });
}

/** A flight this close is worth a message at night: the gate, the leave time. */
const nightFlightHorizonMs = 12 * 60 * 60_000;

const flightWords =
  /рейс|вылет|перел[её]т|аэропорт|аэроэкспресс|шереметьев|внуков|домодедов|пулков|кольцов|толмач[её]в|flight|airport|boarding|✈/iu;
// «SU 1234», «DP405»: an airline code and a number.
const flightNumber = /\b[A-Z]{2} ?\d{2,4}\b/u;

type CalendarEventFacts = Pick<
  NonNullable<z.output<typeof calendarEventListSchema>["items"]>[number],
  "id" | "location" | "start" | "status" | "summary"
>;

/** Whether an event is a flight, by its title or place. */
function isFlight(event: CalendarEventFacts) {
  const text = [event.summary, event.location].filter(Boolean).join(" ");
  return flightWords.test(text) || flightNumber.test(event.summary ?? "");
}

/**
 * Whether a night check may wake the person for an event: a flight leaving
 * within hours — they may have to leave for it before the quiet hours end. A
 * meeting in the morning waits for the morning check.
 */
export function isNightFlight(event: CalendarEventFacts, now: Date) {
  const start = Date.parse(event.start?.dateTime ?? "");
  return isFlight(event) && start - now.getTime() <= nightFlightHorizonMs;
}

/** Most airlines open online check-in this long before departure. */
const checkInOpensMs = 24 * 60 * 60_000;
/** Closer to departure than this the person is on the way; no check-in nudge. */
const checkInNudgeUntilMs = 3 * 60 * 60_000;
/**
 * Tonight's reminder is for a flight tomorrow before noon: leaving home for
 * it falls into the night or right after it, before the first morning check.
 */
const eveningFlightBeforeMinute = 12 * 60;
/**
 * Tonight's reminder goes out from 18:00 until 23:00 local. Bro's quiet hours
 * start at 22:00, but people are still up then, and a flight at dawn is worth
 * one late message; past 23:00 it would wake them.
 */
const eveningFromMinute = 18 * 60;
const eveningUntilMinute = 23 * 60;

const reminderKinds = ["checkin", "evening"] as const;

type FlightReminder = (typeof reminderKinds)[number];

/** Which timed reminder a calendar signal is, if it is one. */
export function reminderOf(dedupeKey: string) {
  return reminderKinds.find((reminder) => dedupeKey.endsWith(`#${reminder}`));
}

/** The local date after `date` (`YYYY-MM-DD`). */
function nextDate(date: string) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * Reminders about flights that are due now, whether or not a check has seen
 * the flight before: seeing it once, days ahead, is not telling the person in
 * time. Each is its own signal, keyed by the event, its start and the kind,
 * so it reaches one run once, and a moved flight is reminded of again.
 * - `checkin`: online check-in has opened. Only by day: a check-in opening at
 *   night waits for the first morning check.
 * - `evening`: the flight leaves tomorrow morning; the reminder goes out in
 *   the evening before the person sleeps (`eveningFromMinute`).
 */
export function flightReminders(
  events: readonly CalendarEventFacts[],
  now: Date,
  timeZone: string,
  options: { readonly night: boolean }
) {
  const minute = localMinuteOfDay(now, timeZone);
  const evening = minute >= eveningFromMinute && minute < eveningUntilMinute;
  const tomorrow = nextDate(localDate(now, timeZone));
  return events.flatMap((event): ProactiveSignal[] => {
    const start = event.start?.dateTime;
    if (!event.id || !start || event.status === "cancelled") return [];
    if (!isFlight(event)) return [];
    const departure = new Date(start);
    const leavesInMs = departure.getTime() - now.getTime();
    if (!(leavesInMs > 0)) return [];
    const due: FlightReminder[] = [];
    if (
      !options.night &&
      leavesInMs <= checkInOpensMs &&
      leavesInMs > checkInNudgeUntilMs
    ) {
      due.push("checkin");
    }
    if (
      evening &&
      localDate(departure, timeZone) === tomorrow &&
      localMinuteOfDay(departure, timeZone) < eveningFlightBeforeMinute
    ) {
      due.push("evening");
    }
    const itemId = event.id;
    return due.map((reminder) => ({
      dedupeKey: `${itemId}@${start}#${reminder}`,
      itemId,
      source: "calendar",
      threadId: null,
    }));
  });
}

const flightSubject = /рейс|вылет|посадк|flight|boarding|\bgate\b/iu;
const securityWords =
  /безопасност|подозрительн|вход в|новый вход|парол|security|sign-?in|suspicious|unusual activity|password/iu;

/**
 * Mail worth a message at night, by its subject: a flight's change, gate or
 * boarding, and an account's security. The worker then decides; a phishing
 * «служба безопасности банка» reads the same here and waits for the morning
 * once the worker says so.
 */
export function isNightSubject(subject: string) {
  return flightSubject.test(subject) || securityWords.test(subject);
}

const parcelWords =
  /посылк|отправлени|доставк|трек|пункт выдачи|сдэк|cdek|boxberry|почта росси|parcel|package|shipment|delivery|tracking/iu;
const personalLabels = new Set(["CATEGORY_PERSONAL", "IMPORTANT", "STARRED"]);

/**
 * How much a message matters when a backlog does not fit one run, from its
 * headers alone, lower first: 0 — a flight, an account's security (the
 * sender's name counts: phishing signs as a bank's security service) or a
 * parcel; 1 — a person Gmail files as personal or important, or one the
 * person starred; 2 — anything else; 3 — a newsletter or bulk mail
 * (`List-Unsubscribe`, `List-Id`, `Precedence: bulk`).
 */
export function mailRank(mail: {
  readonly bulk: boolean;
  readonly from: string;
  readonly labels: readonly string[];
  readonly subject: string;
}) {
  const said = `${mail.subject} ${mail.from}`;
  if (
    flightSubject.test(mail.subject) ||
    securityWords.test(said) ||
    parcelWords.test(said)
  ) {
    return 0;
  }
  if (mail.bulk) return 3;
  return mail.labels.some((label) => personalLabels.has(label)) ? 1 : 2;
}

/** Where mail that was not ranked stands: after known senders, before bulk. */
const unrankedMail = 2;

/**
 * Keeps a run small: calendar events first, since they are few and
 * time-bound, then mail by `rank` (`mailRank`, by message id) and, within a
 * rank, newest first (Gmail lists newest first). Without ranks it is the
 * newest mail.
 */
export function selectRunSignals(
  signals: readonly ProactiveSignal[],
  rank: ReadonlyMap<string, number> = new Map()
) {
  const mail = signals
    .filter((signal) => signal.source === "gmail")
    .map((signal, order) => ({
      order,
      rank: rank.get(signal.itemId) ?? unrankedMail,
      signal,
    }))
    .toSorted(
      (left, right) => left.rank - right.rank || left.order - right.order
    )
    .map(({ signal }) => signal);
  return [
    ...signals.filter((signal) => signal.source === "calendar"),
    ...mail,
  ].slice(0, maxSignalsPerRun);
}

/**
 * Where the person lives, from Personal Info: a flight's leave-by time is
 * counted from there, and a guess from the city centre says so.
 */
function homeLine(
  home: Pick<UserProfile, "addressLine1" | "addressLine2" | "city" | "region">
) {
  const address = [home.addressLine1, home.addressLine2, home.city, home.region]
    .filter(Boolean)
    .join(", ");
  return address
    ? `Home (Personal Info; count a leave-by time from here): ${address}`
    : "Home address: not in Personal Info; take it from memory if it is there, otherwise count a leave-by time from the city centre and say so.";
}

/** What the worker is to say about a flight for each timed reminder. */
const reminderTasks = {
  checkin:
    "online check-in is open now (most airlines open it 24 hours before departure): say until when, and offer to check in and pick a seat as soon as the person says yes.",
  evening: `it leaves tomorrow morning, and this is tonight's reminder, before the person goes to sleep: when to leave home and how at that hour, an alarm, check-in, documents. Make ${urgentHandoverMarker} the first line of your handover: it has to reach the person tonight, even if their quiet hours begin before you finish.`,
} satisfies Record<FlightReminder, string>;

/**
 * The flights with a reminder due, one line each. Earlier checks may have
 * looked at these flights already and handed nothing over; the reminder is
 * new, and the worker would otherwise skip a flight it was told is not.
 */
function reminderLines(
  signals: readonly Pick<ProactiveSignal, "dedupeKey" | "itemId">[]
) {
  const due = new Map<string, FlightReminder[]>();
  for (const signal of signals) {
    const reminder = reminderOf(signal.dedupeKey);
    if (reminder)
      due.set(signal.itemId, [...(due.get(signal.itemId) ?? []), reminder]);
  }
  if (due.size === 0) return undefined;
  return [
    "Flight reminders due now. Earlier checks may have seen these flights; what is new is the time. Hand each over as a flight, even when nothing about it changed:",
    ...[...due].map(
      ([itemId, reminders]) =>
        `- ${itemId}: ${reminders.map((reminder) => reminderTasks[reminder]).join(" Also, ")}`
    ),
  ].join("\n");
}

/** The worker's task: exactly which items are new, and how to read them. */
export function proactiveRunPrompt(input: {
  readonly home: Parameters<typeof homeLine>[0];
  /** When the person's night ends, if the check runs during it. */
  readonly quietUntil?: string;
  readonly scheduledFor: Date;
  readonly signals: readonly Pick<
    ProactiveSignal,
    "dedupeKey" | "itemId" | "source" | "threadId"
  >[];
}) {
  const threads = [
    ...new Set(
      input.signals.flatMap((signal) =>
        signal.source === "gmail" ? [signal.threadId ?? signal.itemId] : []
      )
    ),
  ];
  const calendar = input.signals.filter(
    (signal) => signal.source === "calendar"
  );
  const events = [
    ...new Set(
      calendar.flatMap((signal) =>
        reminderOf(signal.dedupeKey) ? [] : [signal.itemId]
      )
    ),
  ];
  const reminders = reminderLines(calendar);
  const horizon = new Date(input.scheduledFor.getTime() + calendarHorizonMs);
  const calendarLookup = `call calendar-list-events once with timeMin ${input.scheduledFor.toISOString()} and timeMax ${horizon.toISOString()}`;
  return [
    "Proactive check of the person's mail and calendar. Nobody asked for it; decide what, if anything, is worth writing first about.",
    `Checked at: ${input.scheduledFor.toISOString()}`,
    homeLine(input.home),
    input.quietUntil
      ? `It is night for the person: quiet hours until ${input.quietUntil}. Your handover waits for the morning and goes out then together with the rest, unless its first line is ${urgentHandoverMarker} — only for what cannot wait until then.`
      : undefined,
    threads.length > 0
      ? `New Gmail threads (read each with gmail-read-thread): ${threads.join(", ")}`
      : "No new mail.",
    events.length > 0
      ? `New calendar events (${calendarLookup}, then look only at these ids${reminders ? " and the flights below" : ""}): ${events.join(", ")}`
      : reminders
        ? `No new calendar events. For the flights below, ${calendarLookup}.`
        : "No new calendar events.",
    reminders,
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

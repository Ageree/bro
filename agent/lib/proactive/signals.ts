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

/**
 * Whether a night check may wake the person for an event: a flight, by its
 * title or place, leaving within hours — they may have to leave for it before
 * the quiet hours end. A meeting in the morning waits for the morning check.
 */
export function isNightFlight(
  event: {
    readonly location?: string | null;
    readonly start?: { readonly dateTime?: string | null } | null;
    readonly summary?: string | null;
  },
  now: Date
) {
  const text = [event.summary, event.location].filter(Boolean).join(" ");
  const flight =
    flightWords.test(text) || flightNumber.test(event.summary ?? "");
  const start = Date.parse(event.start?.dateTime ?? "");
  return flight && start - now.getTime() <= nightFlightHorizonMs;
}

/**
 * Mail worth a message at night, by its subject: a flight's change, gate or
 * boarding, and an account's security. The worker then decides; a phishing
 * «служба безопасности банка» reads the same here and waits for the morning
 * once the worker says so.
 */
const nightSubject =
  /рейс|вылет|посадк|flight|boarding|\bgate\b|безопасност|подозрительн|вход в|новый вход|парол|security|sign-?in|suspicious|unusual activity|password/iu;

export function isNightSubject(subject: string) {
  return nightSubject.test(subject);
}

/**
 * Keeps a run small: calendar events first, since they are few and
 * time-bound, then the newest mail (Gmail lists newest first).
 */
export function selectRunSignals(signals: readonly ProactiveSignal[]) {
  return [
    ...signals.filter((signal) => signal.source === "calendar"),
    ...signals.filter((signal) => signal.source === "gmail"),
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

/** The worker's task: exactly which items are new, and how to read them. */
export function proactiveRunPrompt(input: {
  readonly home: Parameters<typeof homeLine>[0];
  /** When the person's night ends, if the check runs during it. */
  readonly quietUntil?: string;
  readonly scheduledFor: Date;
  readonly signals: readonly Pick<
    ProactiveSignal,
    "itemId" | "source" | "threadId"
  >[];
}) {
  const threads = [
    ...new Set(
      input.signals.flatMap((signal) =>
        signal.source === "gmail" ? [signal.threadId ?? signal.itemId] : []
      )
    ),
  ];
  const events = [
    ...new Set(
      input.signals.flatMap((signal) =>
        signal.source === "calendar" ? [signal.itemId] : []
      )
    ),
  ];
  const horizon = new Date(input.scheduledFor.getTime() + calendarHorizonMs);
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
      ? `New calendar events (call calendar-list-events once with timeMin ${input.scheduledFor.toISOString()} and timeMax ${horizon.toISOString()}, then look only at these ids): ${events.join(", ")}`
      : "No new calendar events.",
  ]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

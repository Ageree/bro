import type { ProactiveSignal } from "@db/services/proactive";

/** How far ahead a check looks for events: tomorrow's flight plus slack. */
export const calendarHorizonMs = 26 * 60 * 60_000;
/** Mail may arrive a little after its date; checks overlap by this much. */
const mailOverlapMs = 10 * 60_000;
/** Mail older than a day is not news, however long the checks paused. */
const mailLookbackLimitMs = 24 * 60 * 60_000;
/**
 * One run reads at most this many items. Whatever is left over is still
 * unseen, so the next check hands it over (the schedule keeps the mail
 * watermark where it was for that).
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
 * Inbox mail since `after`, without promotions, social notifications and the
 * person's own messages. Package and travel notices sit in Updates and stay.
 */
export function gmailProbeQuery(after: Date) {
  return `in:inbox after:${String(Math.floor(after.getTime() / 1_000))} -category:promotions -category:social -from:me`;
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

/** The worker's task: exactly which items are new, and how to read them. */
export function proactiveRunPrompt(input: {
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
  const events = input.signals.flatMap((signal) =>
    signal.source === "calendar" ? [signal.itemId] : []
  );
  const horizon = new Date(input.scheduledFor.getTime() + calendarHorizonMs);
  return [
    "Proactive check of the person's mail and calendar. Nobody asked for it; decide what, if anything, is worth writing first about.",
    `Checked at: ${input.scheduledFor.toISOString()}`,
    threads.length > 0
      ? `New Gmail threads (read each with gmail-read-thread): ${threads.join(", ")}`
      : "No new mail.",
    events.length > 0
      ? `New calendar events (call calendar-list-events once with timeMin ${input.scheduledFor.toISOString()} and timeMax ${horizon.toISOString()}, then look only at these ids): ${events.join(", ")}`
      : "No new calendar events.",
  ].join("\n\n");
}

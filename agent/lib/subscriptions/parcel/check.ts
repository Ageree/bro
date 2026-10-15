import type { SubscriptionCheck } from "@db/services/subscriptions";
import {
  type ParcelState,
  unreadParcelState,
} from "@shared/subscriptions/parcel";
import type { ParcelWatch } from "../watches";
import type { ParcelRead } from "./pochta";

/** The longest a failing watch waits between tries. */
const maximumBackoffMs = 24 * 60 * 60_000;

/** Days of storage left at which the person hears that it ends. */
const storageWarningDays = 2;

/**
 * A summary the run's outcome takes (`shared/schedules/outcome.ts` allows
 * 4 000): one that would not parse would be a report never sent.
 */
function fitted(summary: string) {
  return summary.length <= 3_900 ? summary : `${summary.slice(0, 3_899)}…`;
}

/** The carrier's words, quoted as data: no quotes of their own, one line. */
function quoted(text: string) {
  return `«${text
    .replaceAll(/[«»]/gu, '"')
    .replaceAll(/\s+/gu, " ")
    .trim()}»`;
}

/** Today on Moscow's clock, where Russian Post counts its days. */
function moscowToday(now: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).format(now);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(to) - Date.parse(from)) / (24 * 60 * 60_000));
}

/** «Посылка из Казани» (80080123456789), or the number alone. */
function parcelName(watch: Pick<ParcelWatch, "source">) {
  const { number, title } = watch.source;
  return title ? `${quoted(title)} (${number})` : number;
}

/** Where a watch came from, for the report turn's words. */
function originWords(watch: Pick<ParcelWatch, "source">) {
  return watch.source.origin === "person"
    ? "The parcel watch the person asked for"
    : "The parcel watch Bro set up from Russian Post's letter to the person";
}

/** What the carrier last said, for a report. */
function lastWords(state: Pick<ParcelState, "lastEvent" | "lastEventAt">) {
  if (!state.lastEvent) return "Russian Post has not said anything of it yet";
  const at = state.lastEventAt ? ` (${state.lastEventAt})` : "";
  return `Russian Post's last word: ${quoted(state.lastEvent)}${at}`;
}

type ParcelReading = Extract<ParcelRead, { kind: "parcel" }>;

/**
 * The state a reading leaves: what the carrier says now, and what the person
 * was already told of. A date the carrier stopped giving keeps the last one
 * known, so a gap in its answer is no «new date» when the date comes back.
 */
function nextState(
  state: ParcelState,
  reading: ParcelReading,
  now: Date
): ParcelState {
  return {
    expectedOn: reading.expectedOn ?? state.expectedOn,
    lastEvent: reading.lastEvent,
    lastEventAt: reading.lastEventAt,
    lastSeenAt: now.toISOString(),
    place: reading.place,
    seen: state.seen || reading.status !== "unknown",
    status: reading.status,
    storageUntil: reading.storageUntil,
    storageWarned: state.storageWarned,
  };
}

/**
 * Whether a parcel's storage ends within two days, or already has: the
 * carrier says so, or its date does.
 */
function storageEnding(
  reading: ParcelReading,
  state: Pick<ParcelState, "storageUntil">,
  now: Date
) {
  return (
    reading.status === "arrived" &&
    (reading.storageEnding ||
      (state.storageUntil !== null &&
        daysBetween(moscowToday(now), state.storageUntil) <=
          storageWarningDays))
  );
}

/**
 * A watch's state from the reading it starts with: what the person hears
 * when it is set up is no news later, its storage ending included.
 */
export function startingParcelState(
  reading: ParcelReading,
  now: Date
): ParcelState {
  const state = nextState(unreadParcelState(now), reading, now);
  return storageEnding(reading, state, now)
    ? { ...state, storageWarned: state.storageUntil ?? moscowToday(now) }
    : state;
}

/**
 * Decides what one check of a parcel found. Only a change is news: a new
 * expected date, arriving where it is collected, its storage there ending
 * within two days (once per storage end: an extension warns again), and its
 * return or loss, which end the watch. A parcel handed over ends it without a
 * word: the person has it. The first reading of a watch from a carrier's
 * letter is its baseline, never news: the letter itself went to the person.
 * Nothing but the carrier's own words, its dates and the number reaches the
 * outcome the report turn reads.
 */
export function judgeParcelCheck(
  watch: Pick<
    ParcelWatch,
    "checkEverySeconds" | "expiresAt" | "failures" | "source" | "state"
  >,
  reading: ParcelRead,
  now: Date
): SubscriptionCheck {
  const { source, state } = watch;
  const period = watch.checkEverySeconds * 1_000;
  const name = parcelName(watch);
  if (watch.expiresAt.getTime() <= now.getTime()) {
    // A number from a letter that Russian Post never knew was no parcel.
    if (!state.seen && source.origin === "mail") return { kind: "lapsed" };
    return {
      kind: "expired",
      outcome: {
        kind: "result",
        summary: fitted(
          `${originWords(watch)} has ended its term with the parcel ${name} not yet handed over. ${lastWords(state)}. Say the watch ended and offer to start it again.`
        ),
        urgency: "normal",
      },
    };
  }
  if (reading.kind !== "parcel") {
    return {
      error: `${reading.kind}: ${reading.reason}`,
      kind: "failed",
      nextCheckAt: new Date(
        now.getTime() +
          Math.min(period * 2 ** (watch.failures + 1), maximumBackoffMs)
      ),
      outcome: {
        kind: "blocked",
        summary: fitted(
          `${originWords(watch)} stopped: three checks in a row could not read the parcel ${name} at Russian Post (${reading.kind === "blocked" ? "the site refused the request" : "the site did not answer in a form code can read"}). ${lastWords(state)}.`
        ),
        userActionNeeded:
          "Offer to look the number up on pochta.ru with the browser, or to start the watch again later.",
      },
    };
  }
  const next = nextState(state, reading, now);
  const quiet: SubscriptionCheck = {
    kind: "quiet",
    nextCheckAt: new Date(now.getTime() + period),
    state: next,
  };
  if (reading.status === "delivered") return { kind: "done", state: next };
  // A letter's number: the person has heard the letter; this is the start.
  if (!state.seen && source.origin === "mail") return quiet;
  if (reading.status === "returned" || reading.status === "lost") {
    return {
      kind: "hit",
      outcome: {
        kind: "result",
        summary: fitted(
          `${originWords(watch)}: the parcel ${name} ${reading.status === "returned" ? "is being returned to the sender" : "is registered as lost or destroyed"}. ${lastWords(next)}. Tell the person in one short message. The watch has ended.`
        ),
        urgency: "normal",
      },
      state: next,
    };
  }
  const news: string[] = [];
  if (reading.status === "arrived" && state.status !== "arrived") {
    news.push(
      `it has arrived where it is collected${next.place ? `: ${quoted(next.place)}` : ""}${next.storageUntil ? `, and is kept there until ${next.storageUntil}` : ""}`
    );
  }
  if (
    reading.status !== "arrived" &&
    reading.expectedOn !== null &&
    state.expectedOn !== null &&
    reading.expectedOn !== state.expectedOn
  ) {
    news.push(
      `Russian Post now expects to deliver it on ${reading.expectedOn} (it said ${state.expectedOn} before)`
    );
  }
  // Once per storage end; without a date, once for the stay.
  const warned =
    state.storageWarned !== null &&
    (next.storageUntil === null || state.storageWarned === next.storageUntil);
  const warnStorage = storageEnding(reading, next, now) && !warned;
  if (warnStorage) {
    news.push(
      `its storage ${next.place ? `at ${quoted(next.place)} ` : ""}ends ${next.storageUntil ? `on ${next.storageUntil}` : "within two days"}; after that Russian Post sends it back to the sender`
    );
  }
  if (news.length === 0) return quiet;
  return {
    kind: "news",
    nextCheckAt: new Date(now.getTime() + period),
    outcome: {
      kind: "result",
      summary: fitted(
        `${originWords(watch)}: the parcel ${name} — ${news.join("; ")}. ${lastWords(next)}. Tell the person in one short message, in their language; the watch goes on and tells only of the next change.`
      ),
      urgency: warnStorage ? "time_sensitive" : "normal",
    },
    state: {
      ...next,
      storageWarned: warnStorage
        ? (next.storageUntil ?? moscowToday(now))
        : state.storageWarned,
    },
  };
}

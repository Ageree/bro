import { createHash } from "node:crypto";
import type { SessionContext } from "eve/context";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { defaultTimeZone } from "@shared/user-profile/schema";
import {
  describeSpan,
  freeWindows,
  type Interval,
  knownTimeZone,
  mergeIntervals,
  zoneOffsetMinutes,
} from "./availability";
import {
  type GoogleClient,
  googleApiErrorStatus,
  googleUrl,
  withGoogleAuth,
} from "./client";
import { emailAddressSchema } from "./email";

/** The Google Calendar REST API. */
export const calendarApi = "https://www.googleapis.com/calendar/v3";

/**
 * A time zone only for Bro's own clock math: an IANA name, or a `+05:00`
 * offset (a colleague's zone taken from their letters).
 */
const localTimeZoneSchema = z.string().min(1).max(64).refine(knownTimeZone, {
  message:
    "Use an IANA time zone such as Europe/Moscow, or a UTC offset such as +05:00.",
});

/**
 * A time zone that goes to Google: IANA names only. Google refuses an offset
 * such as `+05:00` with a 400 — after the person approved the card.
 */
const googleTimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/^[+-]/u.test(value.trim()) && knownTimeZone(value), {
    message:
      "Use an IANA time zone such as Europe/Moscow or Asia/Yekaterinburg, not an offset.",
  });

/** Zone names that assert no local clock: the card leaves them out. */
const utcNames = /^(?:utc|etc\/utc|gmt|etc\/gmt|z)$/iu;

/** The UTC offset, in minutes, an ISO instant is written in. */
function writtenOffsetMinutes(iso: string) {
  const match = /(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(iso);
  if (!match) return undefined;
  const [, sign, hours, minutes] = match;
  if (sign === undefined) return 0;
  const total = Number(hours) * 60 + Number(minutes);
  return sign === "-" ? -total : total;
}

/**
 * Whether times written with an offset are on the clock of the zone named
 * with them. The card shows the time as written next to the zone's name, so
 * «11:30 (Europe/Moscow)» must not mean 11:30 UTC, which Google would book
 * at 14:30 in Moscow.
 */
function writtenInZone(
  times: readonly (string | undefined)[],
  timeZone: string | undefined
) {
  if (
    timeZone === undefined ||
    utcNames.test(timeZone.trim()) ||
    !knownTimeZone(timeZone)
  ) {
    return true;
  }
  return times.every(
    (time) =>
      time === undefined ||
      writtenOffsetMinutes(time) ===
        zoneOffsetMinutes(Date.parse(time), timeZone)
  );
}

const writtenInZoneMessage =
  "start and end must be written in the offset `timezone` has on that date (Europe/Moscow is +03:00): the approval card shows the time as written, next to the zone. Write them in that zone's offset, or leave timezone out.";

export const calendarEventSchema = z
  .object({
    attendees: z.array(emailAddressSchema).max(50).default([]),
    calendarId: z.string().default("primary"),
    description: z.string().max(8_000).optional(),
    end: z.iso.datetime({ offset: true }),
    location: z.string().max(1_000).optional(),
    start: z.iso.datetime({ offset: true }),
    summary: z.string().min(1).max(1_000),
    timezone: googleTimeZoneSchema
      .optional()
      .describe(
        "IANA time zone of the event, e.g. Europe/Moscow; start and end are written in its offset. Omit to use the person's own."
      ),
  })
  .refine((input) => writtenInZone([input.start, input.end], input.timezone), {
    message: writtenInZoneMessage,
    path: ["timezone"],
  });

/**
 * The event a change or deletion is about, by the title the approval card
 * shows. A card that named one event must not change another.
 */
const eventTitleSchema = z
  .string()
  .min(1)
  .max(1_000)
  .describe(
    "The event's current title as calendar-list-events shows it. The approval card names the event by it, and nothing changes if the id belongs to an event with another title."
  );

/** Which event of a recurring series a change or deletion is about. */
const eventOccurrenceFields = {
  eventStart: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      "When the event (or this occurrence) starts, as calendar-list-events shows it: the card shows the date, and nothing changes if the event starts at another time."
    ),
  series: z
    .boolean()
    .optional()
    .describe(
      "true only when the person asked to change or delete a whole recurring series and eventId is the series itself; the card then says so. calendar-list-events lists single occurrences, each with its own id: without series, only that occurrence changes."
    ),
};

/**
 * A change to one existing event: any of its title, notes, place, or time.
 * A new time names both ends, so the event never ends before it starts.
 */
export const calendarEventUpdateSchema = z
  .object({
    calendarId: z.string().default("primary"),
    description: z.string().max(8_000).optional(),
    end: z.iso.datetime({ offset: true }).optional(),
    eventId: z.string().min(1),
    eventTitle: eventTitleSchema,
    ...eventOccurrenceFields,
    location: z.string().max(1_000).optional(),
    start: z.iso.datetime({ offset: true }).optional(),
    summary: z
      .string()
      .min(1)
      .max(1_000)
      .optional()
      .describe("A new title, only when renaming."),
    timezone: googleTimeZoneSchema.optional(),
  })
  .refine(
    (input) => (input.start === undefined) === (input.end === undefined),
    {
      message: "Pass start and end together to move an event.",
    }
  )
  .refine(
    (input) =>
      [input.summary, input.description, input.location, input.start].some(
        (value) => value !== undefined
      ),
    { message: "Pass at least one field to change." }
  )
  .refine((input) => writtenInZone([input.start, input.end], input.timezone), {
    message: writtenInZoneMessage,
    path: ["timezone"],
  });

export const calendarEventDeleteSchema = z.object({
  calendarId: z.string().default("primary"),
  eventId: z.string().min(1),
  eventTitle: eventTitleSchema,
  ...eventOccurrenceFields,
});

/** The most free windows one answer lists: enough for a week of proposals. */
const maximumWindows = 30;

/** The longest stretch one availability check may cover. */
const maximumAvailabilityDays = 31;

const dayMs = 24 * 60 * 60_000;

/** A colleague's working day, in their own time zone. */
const attendeeWorkingHours = { from: 9, to: 19 } as const;

export const calendarAvailabilityInputSchema = z
  .object({
    attendeeTimeZone: localTimeZoneSchema
      .optional()
      .describe(
        "Time zone of the person you are finding a time with, when their clock differs from the person's: an IANA name such as Asia/Yekaterinburg, or a UTC offset such as +05:00. Free windows then also fit their working day (9:00–19:00 their time), and each shows their local time under `attendee`."
      ),
    calendars: z.array(z.string()).min(1).max(10).default(["primary"]),
    dayEndHour: z
      .number()
      .int()
      .min(1)
      .max(24)
      .default(20)
      .describe(
        "Free windows end by this hour of the person's day (default 20). Raise it for an evening block."
      ),
    dayStartHour: z
      .number()
      .int()
      .min(0)
      .max(23)
      .default(9)
      .describe(
        "Free windows start from this hour of the person's day (default 9). Lower it for an early block."
      ),
    slotMinutes: z
      .number()
      .int()
      .min(5)
      .max(480)
      .default(30)
      .describe(
        "How long the meeting or block is: only free windows at least this long are listed."
      ),
    timeMax: z.iso.datetime({ offset: true }),
    timeMin: z.iso.datetime({ offset: true }),
    timezone: googleTimeZoneSchema
      .optional()
      .describe(
        "The person's IANA time zone. Omit to use the one in their profile."
      ),
  })
  .refine((input) => input.dayEndHour > input.dayStartHour, {
    message: "dayEndHour must be after dayStartHour.",
    path: ["dayEndHour"],
  })
  .refine(
    (input) => {
      const span = Date.parse(input.timeMax) - Date.parse(input.timeMin);
      return span > 0 && span <= maximumAvailabilityDays * dayMs;
    },
    {
      message: `timeMax must be after timeMin, at most ${String(maximumAvailabilityDays)} days later.`,
      path: ["timeMax"],
    }
  );

const eventTimeSchema = z.object({
  date: z.string().optional(),
  dateTime: z.string().optional(),
  timeZone: z.string().optional(),
});

/** An event as Google returns it, the fields Bro asks for and reads. */
const googleEventSchema = z.object({
  attendees: z
    .array(
      z.object({
        email: z.string().optional(),
        responseStatus: z.string().optional(),
      })
    )
    .optional(),
  description: z.string().optional(),
  end: eventTimeSchema.optional(),
  htmlLink: z.string().optional(),
  id: z.string().optional(),
  location: z.string().optional(),
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  start: eventTimeSchema.optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  transparency: z.string().optional(),
});

type GoogleEvent = z.infer<typeof googleEventSchema>;

export const calendarEventListSchema = z.object({
  items: z.array(googleEventSchema).optional(),
});

/** One calendar's events at `path`, relative to the calendar. */
function eventsUrl(
  calendarId: string,
  path: string,
  query?: Parameters<typeof googleUrl>[2]
) {
  return googleUrl(
    calendarApi,
    `/calendars/${encodeURIComponent(calendarId)}/events${path}`,
    query
  );
}

/** The time zone in the person's profile, Moscow when they never set one. */
async function personTimeZone(ctx: Pick<SessionContext, "session">) {
  const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
  if (caller?.principalType !== "user") return defaultTimeZone;
  return readWorkspaceTimeZone(scopeFromPrincipal(caller));
}

export async function listCalendarEvents(
  ctx: ToolContext,
  input: {
    calendarId: string;
    maxResults: number;
    timeMax: string;
    timeMin: string;
  }
) {
  return withGoogleAuth(ctx, async (google) => {
    const listed = await google.json(calendarEventListSchema, {
      url: eventsUrl(input.calendarId, "", {
        fields:
          "items(id,recurringEventId,status,summary,description,location,start,end,attendees(email,responseStatus),htmlLink)",
        maxResults: input.maxResults,
        orderBy: "startTime",
        singleEvents: true,
        timeMax: input.timeMax,
        timeMin: input.timeMin,
      }),
    });
    return { events: listed.items ?? [] };
  });
}

const freeBusyResponseSchema = z.object({
  calendars: z
    .record(
      z.string(),
      z.object({
        busy: z
          .array(z.object({ end: z.string(), start: z.string() }))
          .optional(),
        errors: z
          .array(
            z.object({
              domain: z.string().optional(),
              reason: z.string().optional(),
            })
          )
          .optional(),
      })
    )
    .optional(),
  timeMax: z.string().optional(),
  timeMin: z.string().optional(),
});

/** An event's span when it has clock times; an all-day event has none. */
function eventSpan(event: GoogleEvent): Interval | undefined {
  const start = Date.parse(event.start?.dateTime ?? "");
  const end = Date.parse(event.end?.dateTime ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? { end, start }
    : undefined;
}

/** Events that take the time: not cancelled, not marked «free». */
function blockingEvents(events: readonly GoogleEvent[]) {
  return events.flatMap((event) => {
    const span = eventSpan(event);
    const title = event.summary?.trim() ?? "";
    return span &&
      event.status !== "cancelled" &&
      event.transparency !== "transparent"
      ? [{ span, title: title === "" ? "(без названия)" : title }]
      : [];
  });
}

function overlaps(left: Interval, right: Interval) {
  return left.start < right.end && right.start < left.end;
}

/**
 * Free and busy time for the person between two instants: busy spans with
 * the titles of the events behind them, and the free windows at least
 * `slotMinutes` long inside their day hours — and inside the attendee's
 * working day when their time zone is given — each in both clocks.
 */
export async function checkCalendarAvailability(
  ctx: ToolContext,
  input: z.output<typeof calendarAvailabilityInputSchema>
) {
  const timeZone = input.timezone ?? (await personTimeZone(ctx));
  const range = {
    end: Date.parse(input.timeMax),
    start: Date.parse(input.timeMin),
  };
  return withGoogleAuth(ctx, async (google) => {
    const [answer, listed] = await Promise.all([
      google.json(freeBusyResponseSchema, {
        body: {
          items: input.calendars.map((id) => ({ id })),
          timeMax: input.timeMax,
          timeMin: input.timeMin,
          timeZone,
        },
        method: "POST",
        url: googleUrl(calendarApi, "/freeBusy"),
      }),
      // Titles only name the busy time; the answer stands without them.
      input.calendars.includes("primary")
        ? google
            .json(calendarEventListSchema, {
              url: eventsUrl("primary", "", {
                fields: "items(summary,status,transparency,start,end)",
                maxResults: 100,
                orderBy: "startTime",
                singleEvents: true,
                timeMax: input.timeMax,
                timeMin: input.timeMin,
              }),
            })
            .catch(() => ({ items: [] }))
        : { items: [] },
    ]);
    const busy = mergeIntervals(
      Object.values(parseCalendarAvailability(answer).calendars ?? {})
        .flatMap((calendar) => calendar.busy ?? [])
        .map((span) => ({
          end: Math.min(Date.parse(span.end), range.end),
          start: Math.max(Date.parse(span.start), range.start),
        }))
        .filter((span) => span.end > span.start)
    );
    const events = blockingEvents(listed.items ?? []);
    const attendee = input.attendeeTimeZone
      ? { hours: attendeeWorkingHours, timeZone: input.attendeeTimeZone }
      : undefined;
    const free = freeWindows({
      attendee,
      busy,
      hours: { from: input.dayStartHour, to: input.dayEndHour },
      range,
      slotMinutes: input.slotMinutes,
      timeZone,
    });
    const shown = free.slice(0, maximumWindows);
    const firstUnlisted = free[shown.length];
    const cut =
      firstUnlisted === undefined
        ? ""
        : ` Only the first ${String(shown.length)} of ${String(free.length)} free windows are listed; later ones exist from ${describeSpan(firstUnlisted, timeZone).date} on — check again from there before saying the rest of the range is busy.`;
    return {
      attendeeTimeZone: attendee?.timeZone ?? null,
      busy: busy.map((span) =>
        Object.assign(describeSpan(span, timeZone), {
          events: events
            .filter((event) => overlaps(event.span, span))
            .map((event) => event.title),
        })
      ),
      free: shown.map((span) =>
        describeSpan(span, timeZone, attendee?.timeZone)
      ),
      note: `Free windows are within ${String(input.dayStartHour)}:00–${String(input.dayEndHour)}:00 of the person's day in ${timeZone}${attendee ? ` and within 9:00–19:00 in ${attendee.timeZone}` : ""}, at least ${String(input.slotMinutes)} minutes long. Offer or book only these; name a busy event by its title when a time the person named is taken.${cut}`,
      timeZone,
      unlistedFree: free.length - shown.length,
    };
  });
}

export function parseCalendarAvailability(
  value: z.output<typeof freeBusyResponseSchema>
) {
  const failures = Object.entries(value.calendars ?? {}).flatMap(
    ([calendarId, calendarResult]) =>
      (calendarResult.errors ?? []).map(
        (error) => `${calendarId}: ${error.reason ?? error.domain ?? "unknown"}`
      )
  );
  if (failures.length > 0) {
    throw new Error(
      `Google Calendar could not read availability for ${failures.join(", ")}.`
    );
  }
  return value;
}

export async function createCalendarEvent(
  ctx: ToolContext,
  payload: z.infer<typeof calendarEventSchema>
) {
  const eventId = createHash("sha256")
    .update(`${ctx.session.id}:${ctx.callId}`)
    .digest("hex")
    .slice(0, 32);
  const timeZone = payload.timezone ?? (await personTimeZone(ctx));
  return withGoogleAuth(ctx, async (google) => {
    try {
      return await google.json(googleEventSchema, {
        body: {
          attendees: payload.attendees.map((email) => ({ email })),
          description: payload.description,
          end: { dateTime: payload.end, timeZone },
          id: eventId,
          location: payload.location,
          start: { dateTime: payload.start, timeZone },
          status: "confirmed",
          summary: payload.summary,
          visibility: "private",
        },
        method: "POST",
        url: eventsUrl(payload.calendarId, "", {
          sendUpdates: payload.attendees.length ? "all" : "none",
        }),
      });
    } catch (error) {
      if (googleApiErrorStatus(error) !== 409) throw error;
      return google.json(googleEventSchema, {
        url: eventsUrl(payload.calendarId, `/${encodeURIComponent(eventId)}`),
      });
    }
  });
}

/**
 * Other events that take the same time as an event just created or moved,
 * so Bro can name the clash as a fact. Only informs: a failed read yields
 * none rather than failing a write that already happened.
 */
export async function calendarOverlaps(
  ctx: ToolContext,
  input: {
    readonly calendarId: string;
    readonly end: string;
    readonly eventId: string | undefined;
    readonly start: string;
  }
) {
  const span = { end: Date.parse(input.end), start: Date.parse(input.start) };
  const timeZone = await personTimeZone(ctx).catch(() => defaultTimeZone);
  try {
    const listed = await withGoogleAuth(ctx, async (google) =>
      google.json(calendarEventListSchema, {
        url: eventsUrl(input.calendarId, "", {
          fields: "items(id,summary,status,transparency,start,end)",
          maxResults: 20,
          orderBy: "startTime",
          singleEvents: true,
          timeMax: input.end,
          timeMin: input.start,
        }),
      })
    );
    const others = (listed.items ?? []).filter(
      (event) => event.id !== input.eventId
    );
    return blockingEvents(others)
      .filter((event) => overlaps(event.span, span))
      .map((event) =>
        Object.assign(describeSpan(event.span, timeZone), {
          title: event.title,
        })
      );
  } catch {
    return [];
  }
}

/** A title as a person compares it: case, spacing and quotes aside. */
function comparableTitle(title: string) {
  return title
    .toLowerCase()
    .replaceAll(/[«»"“”'„]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

/**
 * Whether the title the card showed names this event: the same title, or one
 * contained in the other («Созвон» for «Созвон с командой»). An event with
 * no title matches any.
 */
export function titleNamesEvent(cardTitle: string, eventTitle: string) {
  const card = comparableTitle(cardTitle);
  const actual = comparableTitle(eventTitle);
  if (actual.length === 0 || card === actual) return true;
  const shorter = card.length < actual.length ? card : actual;
  const longer = shorter === card ? actual : card;
  return shorter.length >= 3 && longer.includes(shorter);
}

/** A change refused because the event and what the card said disagree. */
export class CalendarEventMismatchError extends Error {
  override readonly name = "CalendarEventMismatchError";

  constructor(detail: string) {
    super(
      `Nothing changed: ${detail} Find the right event with calendar-list-events and call again with its id, title and start.`
    );
  }
}

/**
 * Reads the event about to change and refuses when it is not the one the
 * approval card showed: another title, another start, or a whole recurring
 * series where the card named one event (a series id with its occurrence
 * suffix dropped deletes every occurrence and mails every guest).
 */
async function requireNamedEvent(
  google: GoogleClient,
  input: {
    readonly calendarId: string;
    readonly eventId: string;
    readonly eventStart?: string | undefined;
    readonly eventTitle?: string | undefined;
    readonly series?: boolean | undefined;
  }
) {
  const event = await google.json(googleEventSchema, {
    url: eventsUrl(input.calendarId, `/${encodeURIComponent(input.eventId)}`, {
      fields: "id,summary,start,recurrence,recurringEventId",
    }),
  });
  const title = event.summary ?? "";
  if (input.eventTitle && !titleNamesEvent(input.eventTitle, title)) {
    throw new CalendarEventMismatchError(
      `the event with this id is «${title}», not «${input.eventTitle}» as the approval card said.`
    );
  }
  const wholeSeries = (event.recurrence ?? []).length > 0;
  if (wholeSeries && input.series !== true) {
    throw new CalendarEventMismatchError(
      `this id is the whole recurring series «${title}», and the card named one event. For one occurrence take its own id from calendar-list-events; for the whole series call again with series: true, only if the person asked for all of them.`
    );
  }
  if (input.series === true && !wholeSeries) {
    throw new CalendarEventMismatchError(
      event.recurringEventId
        ? `this id is one occurrence, and the card named the whole series. The series id is ${event.recurringEventId}.`
        : "this event does not repeat, and the card named a whole series: call again without series."
    );
  }
  const start = event.start?.dateTime;
  if (
    input.series !== true &&
    input.eventStart !== undefined &&
    start !== undefined &&
    Date.parse(start) !== Date.parse(input.eventStart)
  ) {
    throw new CalendarEventMismatchError(
      `«${title}» with this id starts at ${start}, not at ${input.eventStart} as the approval card said.`
    );
  }
}

/** Moves or renames one event and tells its attendees. */
export async function updateCalendarEvent(
  ctx: ToolContext,
  input: z.infer<typeof calendarEventUpdateSchema>
) {
  const timeZone =
    input.start === undefined
      ? undefined
      : (input.timezone ?? (await personTimeZone(ctx)));
  const time = (dateTime: string | undefined) =>
    dateTime === undefined ? undefined : { dateTime, timeZone };
  return withGoogleAuth(ctx, async (google) => {
    await requireNamedEvent(google, input);
    return google.json(googleEventSchema, {
      body: {
        description: input.description,
        end: time(input.end),
        location: input.location,
        start: time(input.start),
        summary: input.summary,
      },
      method: "PATCH",
      url: eventsUrl(
        input.calendarId,
        `/${encodeURIComponent(input.eventId)}`,
        {
          sendUpdates: "all",
        }
      ),
    });
  });
}

/**
 * Deletes one event and tells its attendees. An event that is already gone
 * counts as deleted, so a retried call does not fail.
 */
export async function deleteCalendarEvent(
  ctx: ToolContext,
  input: z.infer<typeof calendarEventDeleteSchema>
) {
  return withGoogleAuth(ctx, async (google) => {
    try {
      await requireNamedEvent(google, input);
      await google.json(z.unknown(), {
        method: "DELETE",
        url: eventsUrl(
          input.calendarId,
          `/${encodeURIComponent(input.eventId)}`,
          { sendUpdates: "all" }
        ),
      });
      return { alreadyDeleted: false };
    } catch (error) {
      const status = googleApiErrorStatus(error);
      if (status !== 404 && status !== 410) throw error;
      return { alreadyDeleted: true };
    }
  });
}

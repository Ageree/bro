import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { googleApiErrorStatus, googleUrl, withGoogleAuth } from "./client";
import { emailAddressSchema } from "./email";

/** The Google Calendar REST API. */
export const calendarApi = "https://www.googleapis.com/calendar/v3";

export const calendarEventSchema = z.object({
  attendees: z.array(emailAddressSchema).max(50).default([]),
  calendarId: z.string().default("primary"),
  description: z.string().max(8_000).optional(),
  end: z.iso.datetime({ offset: true }),
  location: z.string().max(1_000).optional(),
  start: z.iso.datetime({ offset: true }),
  summary: z.string().min(1).max(1_000),
  timezone: z.string().min(1).default("UTC"),
});

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
    location: z.string().max(1_000).optional(),
    start: z.iso.datetime({ offset: true }).optional(),
    summary: z.string().min(1).max(1_000).optional(),
    timezone: z.string().min(1).optional(),
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
  );

export const calendarEventDeleteSchema = z.object({
  calendarId: z.string().default("primary"),
  eventId: z.string().min(1),
});

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
  start: eventTimeSchema.optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
});

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
          "items(id,status,summary,description,location,start,end,attendees(email,responseStatus),htmlLink)",
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

export async function checkCalendarAvailability(
  ctx: ToolContext,
  input: {
    calendars: string[];
    timeMax: string;
    timeMin: string;
    timezone: string;
  }
) {
  return withGoogleAuth(ctx, async (google) =>
    parseCalendarAvailability(
      await google.json(freeBusyResponseSchema, {
        body: {
          items: input.calendars.map((id) => ({ id })),
          timeMax: input.timeMax,
          timeMin: input.timeMin,
          timeZone: input.timezone,
        },
        method: "POST",
        url: googleUrl(calendarApi, "/freeBusy"),
      })
    )
  );
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
  return withGoogleAuth(ctx, async (google) => {
    try {
      return await google.json(googleEventSchema, {
        body: {
          attendees: payload.attendees.map((email) => ({ email })),
          description: payload.description,
          end: { dateTime: payload.end, timeZone: payload.timezone },
          id: eventId,
          location: payload.location,
          start: { dateTime: payload.start, timeZone: payload.timezone },
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

/** Moves or renames one event and tells its attendees. */
export async function updateCalendarEvent(
  ctx: ToolContext,
  input: z.infer<typeof calendarEventUpdateSchema>
) {
  const time = (dateTime: string | undefined) =>
    dateTime === undefined ? undefined : { dateTime, timeZone: input.timezone };
  return withGoogleAuth(ctx, async (google) =>
    google.json(googleEventSchema, {
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
    })
  );
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

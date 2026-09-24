import { createHash } from "node:crypto";
import { calendar, type calendar_v3 } from "@googleapis/calendar";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { googleApiErrorStatus, withGoogleAuth } from "./client";
import { emailAddressSchema } from "./email";

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

export async function listCalendarEvents(
  ctx: ToolContext,
  input: {
    calendarId: string;
    maxResults: number;
    timeMax: string;
    timeMin: string;
  }
) {
  return withCalendar(ctx, async (client) => {
    const { data } = await client.events.list(
      {
        calendarId: input.calendarId,
        fields:
          "items(id,status,summary,description,location,start,end,attendees(email,responseStatus),htmlLink)",
        maxResults: input.maxResults,
        orderBy: "startTime",
        singleEvents: true,
        timeMax: input.timeMax,
        timeMin: input.timeMin,
      },
      { signal: ctx.abortSignal }
    );
    return { events: data.items ?? [] };
  });
}

export async function checkCalendarAvailability(
  ctx: ToolContext,
  input: {
    calendars: string[];
    timeMax: string;
    timeMin: string;
    timezone: string;
  }
) {
  return withCalendar(ctx, async (client) => {
    const { data } = await client.freebusy.query(
      {
        requestBody: {
          items: input.calendars.map((id) => ({ id })),
          timeMax: input.timeMax,
          timeMin: input.timeMin,
          timeZone: input.timezone,
        },
      },
      { signal: ctx.abortSignal }
    );
    return parseCalendarAvailability(data);
  });
}

export function parseCalendarAvailability(
  value: calendar_v3.Schema$FreeBusyResponse
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
  return withCalendar(ctx, async (client) => {
    try {
      const { data } = await client.events.insert(
        {
          calendarId: payload.calendarId,
          requestBody: {
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
          sendUpdates: payload.attendees.length ? "all" : "none",
        },
        { signal: ctx.abortSignal }
      );
      return data;
    } catch (error) {
      if (googleApiErrorStatus(error) !== 409) throw error;
      const { data } = await client.events.get(
        { calendarId: payload.calendarId, eventId },
        { signal: ctx.abortSignal }
      );
      return data;
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
  return withCalendar(ctx, async (client) => {
    const { data } = await client.events.patch(
      {
        calendarId: input.calendarId,
        eventId: input.eventId,
        requestBody: {
          description: input.description,
          end: time(input.end),
          location: input.location,
          start: time(input.start),
          summary: input.summary,
        },
        sendUpdates: "all",
      },
      { signal: ctx.abortSignal }
    );
    return data;
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
  return withCalendar(ctx, async (client) => {
    try {
      await client.events.delete(
        {
          calendarId: input.calendarId,
          eventId: input.eventId,
          sendUpdates: "all",
        },
        { signal: ctx.abortSignal }
      );
      return { alreadyDeleted: false };
    } catch (error) {
      const status = googleApiErrorStatus(error);
      if (status !== 404 && status !== 410) throw error;
      return { alreadyDeleted: true };
    }
  });
}

function withCalendar<T>(
  ctx: ToolContext,
  execute: (client: ReturnType<typeof calendar>) => Promise<T>
) {
  return withGoogleAuth(ctx, (auth) =>
    execute(calendar({ auth, version: "v3" }))
  );
}

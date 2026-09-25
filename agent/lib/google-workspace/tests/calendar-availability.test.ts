import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import type { readWorkspaceTimeZone } from "@db/services/user-profile";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
  type ProxiedRequest,
} from "@tests/helpers/composio";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
}));
const profile = vi.hoisted(() => ({
  timeZone: vi.fn<typeof readWorkspaceTimeZone>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: profile.timeZone,
}));

import {
  describeSpan,
  freeWindows,
  zonedIso,
} from "@agent/lib/google-workspace/availability";
import {
  CalendarEventMismatchError,
  calendarAvailabilityInputSchema,
  calendarOverlaps,
  checkCalendarAvailability,
  deleteCalendarEvent,
  titleNamesEvent,
  updateCalendarEvent,
} from "@agent/lib/google-workspace/calendar";

const at = (iso: string) => Date.parse(iso);

describe("free windows", () => {
  it("fits a colleague two hours ahead into both working days (RU d09)", () => {
    const busy = [
      {
        end: at("2026-10-02T11:00:00+03:00"),
        start: at("2026-10-02T10:00:00+03:00"),
      },
      {
        end: at("2026-10-02T15:00:00+03:00"),
        start: at("2026-10-02T13:00:00+03:00"),
      },
    ];
    const windows = freeWindows({
      attendee: { hours: { from: 9, to: 19 }, timeZone: "Asia/Yekaterinburg" },
      busy,
      hours: { from: 9, to: 20 },
      range: {
        end: at("2026-10-03T00:00:00+03:00"),
        start: at("2026-10-02T00:00:00+03:00"),
      },
      slotMinutes: 30,
      timeZone: "Europe/Moscow",
    });

    // 19:00 in Yekaterinburg is 17:00 in Moscow: nothing later is offered.
    expect(
      windows.map((window) =>
        describeSpan(window, "Europe/Moscow", "Asia/Yekaterinburg")
      )
    ).toEqual([
      {
        attendee: {
          date: "2026-10-02",
          from: "11:00",
          to: "12:00",
          weekday: "Fri",
        },
        date: "2026-10-02",
        end: "2026-10-02T10:00:00+03:00",
        from: "09:00",
        start: "2026-10-02T09:00:00+03:00",
        to: "10:00",
        weekday: "Fri",
      },
      {
        attendee: {
          date: "2026-10-02",
          from: "13:00",
          to: "15:00",
          weekday: "Fri",
        },
        date: "2026-10-02",
        end: "2026-10-02T13:00:00+03:00",
        from: "11:00",
        start: "2026-10-02T11:00:00+03:00",
        to: "13:00",
        weekday: "Fri",
      },
      {
        attendee: {
          date: "2026-10-02",
          from: "17:00",
          to: "19:00",
          weekday: "Fri",
        },
        date: "2026-10-02",
        end: "2026-10-02T17:00:00+03:00",
        from: "15:00",
        start: "2026-10-02T15:00:00+03:00",
        to: "17:00",
        weekday: "Fri",
      },
    ]);
  });

  it("puts a Thursday-afternoon block only where the afternoon is free (EN D8)", () => {
    const windows = freeWindows({
      busy: [
        {
          end: at("2026-10-01T14:30:00+03:00"),
          start: at("2026-10-01T12:00:00+03:00"),
        },
        {
          end: at("2026-10-01T16:40:00+03:00"),
          start: at("2026-10-01T15:00:00+03:00"),
        },
      ],
      hours: { from: 9, to: 20 },
      range: {
        end: at("2026-10-01T18:00:00+03:00"),
        start: at("2026-10-01T13:00:00+03:00"),
      },
      slotMinutes: 30,
      timeZone: "Europe/Moscow",
    });

    // 14:00 is taken; the first free half hour is 14:30, and a window after
    // a meeting ending 16:40 starts on the quarter hour.
    expect(
      windows.map(({ end, start }) => [
        zonedIso(start, "Europe/Moscow"),
        zonedIso(end, "Europe/Moscow"),
      ])
    ).toEqual([
      ["2026-10-01T14:30:00+03:00", "2026-10-01T15:00:00+03:00"],
      ["2026-10-01T16:45:00+03:00", "2026-10-01T18:00:00+03:00"],
    ]);
  });

  it("drops windows shorter than the meeting", () => {
    expect(
      freeWindows({
        busy: [
          {
            end: at("2026-10-01T14:00:00+03:00"),
            start: at("2026-10-01T13:00:00+03:00"),
          },
          {
            end: at("2026-10-01T15:00:00+03:00"),
            start: at("2026-10-01T14:20:00+03:00"),
          },
        ],
        hours: { from: 9, to: 20 },
        range: {
          end: at("2026-10-01T15:00:00+03:00"),
          start: at("2026-10-01T13:00:00+03:00"),
        },
        slotMinutes: 30,
        timeZone: "Europe/Moscow",
      })
    ).toEqual([]);
  });

  it("keeps the day hours on the local clock across a clock change", () => {
    const windows = freeWindows({
      busy: [],
      hours: { from: 9, to: 17 },
      range: {
        end: at("2026-11-02T00:00:00-05:00"),
        start: at("2026-10-31T00:00:00-04:00"),
      },
      slotMinutes: 30,
      timeZone: "America/New_York",
    });

    expect(
      windows.map(({ end, start }) => [
        zonedIso(start, "America/New_York"),
        zonedIso(end, "America/New_York"),
      ])
    ).toEqual([
      ["2026-10-31T09:00:00-04:00", "2026-10-31T17:00:00-04:00"],
      ["2026-11-01T09:00:00-05:00", "2026-11-01T17:00:00-05:00"],
    ]);
  });
});

const calendarApi = "https://www.googleapis.com/calendar/v3";

let composio: FakeComposio;

beforeEach(() => {
  vi.clearAllMocks();
  settings.access.mockResolvedValue("full");
  profile.timeZone.mockResolvedValue("Europe/Moscow");
  composio = fakeComposio();
  composio.connect({ id: "ca_google", toolkit: "googlesuper" });
});

function route(request: ProxiedRequest) {
  const key = `${request.method} ${request.url.origin}${request.url.pathname}`;
  if (key === `POST ${calendarApi}/freeBusy`) {
    return {
      data: {
        calendars: {
          primary: {
            busy: [
              { end: "2026-10-01T11:30:00Z", start: "2026-10-01T09:00:00Z" },
            ],
          },
        },
      },
    };
  }
  if (key === `GET ${calendarApi}/calendars/primary/events`) {
    return {
      data: {
        items: [
          {
            end: { dateTime: "2026-10-01T14:30:00+03:00" },
            start: { dateTime: "2026-10-01T12:00:00+03:00" },
            summary: "Созвон с командой",
          },
          {
            end: { dateTime: "2026-10-01T15:00:00+03:00" },
            start: { dateTime: "2026-10-01T14:00:00+03:00" },
            summary: "Обед",
            transparency: "transparent",
          },
        ],
      },
    };
  }
  throw new Error(`No fake route for ${key}`);
}

describe("calendar-check-availability", () => {
  it("answers in the person's own time zone with the titles of busy time", async () => {
    composio.proxy.mockImplementation(route);

    const input = calendarAvailabilityInputSchema.parse({
      timeMax: "2026-10-01T18:00:00+03:00",
      timeMin: "2026-10-01T13:00:00+03:00",
    });
    const result = await checkCalendarAvailability(
      composioToolContext("ca_google"),
      input
    );

    expect(profile.timeZone).toHaveBeenCalledOnce();
    expect(result.timeZone).toBe("Europe/Moscow");
    expect(result.busy).toEqual([
      expect.objectContaining({
        events: ["Созвон с командой"],
        from: "13:00",
        to: "14:30",
      }),
    ]);
    expect(result.free).toEqual([
      expect.objectContaining({
        from: "14:30",
        start: "2026-10-01T14:30:00+03:00",
        to: "18:00",
        weekday: "Thu",
      }),
    ]);
    const freeBusy = composio.proxy.mock.calls
      .map(([request]) => request)
      .find((request) => request.url.pathname.endsWith("/freeBusy"));
    expect(freeBusy?.body).toMatchObject({ timeZone: "Europe/Moscow" });
  });

  it("refuses a range over a month and an unknown time zone", () => {
    expect(
      calendarAvailabilityInputSchema.safeParse({
        timeMax: "2026-12-01T00:00:00+03:00",
        timeMin: "2026-10-01T00:00:00+03:00",
      }).success
    ).toBe(false);
    expect(
      calendarAvailabilityInputSchema.safeParse({
        attendeeTimeZone: "Екатеринбург",
        timeMax: "2026-10-02T00:00:00+03:00",
        timeMin: "2026-10-01T00:00:00+03:00",
      }).success
    ).toBe(false);
    expect(
      calendarAvailabilityInputSchema.safeParse({
        attendeeTimeZone: "+05:00",
        timeMax: "2026-10-02T00:00:00+03:00",
        timeMin: "2026-10-01T00:00:00+03:00",
      }).success
    ).toBe(true);
  });
});

describe("a calendar write", () => {
  it("names the other events at the same time", async () => {
    composio.proxy.mockImplementation(route);

    await expect(
      calendarOverlaps(composioToolContext("ca_google"), {
        calendarId: "primary",
        end: "2026-10-01T14:30:00+03:00",
        eventId: "created-1",
        start: "2026-10-01T14:00:00+03:00",
      })
    ).resolves.toEqual([
      expect.objectContaining({
        from: "12:00",
        title: "Созвон с командой",
        to: "14:30",
      }),
    ]);
  });

  it("reports no clash rather than failing when the read fails", async () => {
    composio.proxy.mockResolvedValue({ data: {}, status: 500 });

    await expect(
      calendarOverlaps(composioToolContext("ca_google"), {
        calendarId: "primary",
        end: "2026-10-01T14:30:00+03:00",
        eventId: undefined,
        start: "2026-10-01T14:00:00+03:00",
      })
    ).resolves.toEqual([]);
  });

  it("changes nothing when the id belongs to another event than the card named", async () => {
    composio.proxy.mockImplementation((request) =>
      request.method === "GET"
        ? { data: { id: "event-1", summary: "Стоматолог" } }
        : { data: {} }
    );
    const ctx = composioToolContext("ca_google");

    await expect(
      updateCalendarEvent(ctx, {
        calendarId: "primary",
        end: "2026-10-01T16:00:00+03:00",
        eventId: "event-1",
        eventTitle: "Созвон с Ириной",
        start: "2026-10-01T15:00:00+03:00",
      })
    ).rejects.toBeInstanceOf(CalendarEventMismatchError);
    await expect(
      deleteCalendarEvent(ctx, {
        calendarId: "primary",
        eventId: "event-1",
        eventTitle: "Созвон с Ириной",
      })
    ).rejects.toBeInstanceOf(CalendarEventMismatchError);
    expect(
      composio.proxy.mock.calls.map(([request]) => request.method)
    ).toEqual(["GET", "GET"]);
  });

  it("moves an event into the person's time zone when the call names none", async () => {
    composio.proxy.mockImplementation((request) =>
      request.method === "GET"
        ? { data: { id: "event-1", summary: "Созвон" } }
        : { data: { id: "event-1" } }
    );

    await updateCalendarEvent(composioToolContext("ca_google"), {
      calendarId: "primary",
      end: "2026-10-01T16:00:00+03:00",
      eventId: "event-1",
      eventTitle: "созвон",
      start: "2026-10-01T15:00:00+03:00",
    });

    const patch = composio.proxy.mock.calls
      .map(([request]) => request)
      .find((request) => request.method === "PATCH");
    expect(patch?.body).toMatchObject({
      start: {
        dateTime: "2026-10-01T15:00:00+03:00",
        timeZone: "Europe/Moscow",
      },
    });
  });
});

describe("the event a card names", () => {
  it.each([
    ["Созвон с командой", "Созвон с командой", true],
    ["«Созвон»", "созвон с командой", true],
    ["Встреча с Ириной Павловной (Zoom)", "Встреча с Ириной Павловной", true],
    ["Стоматолог", "Созвон с командой", false],
    ["Со", "Созвон", false],
    ["Что угодно", "", true],
  ])("«%s» for «%s»: %s", (card, event, expected) => {
    expect(titleNamesEvent(card, event)).toBe(expected);
  });
});

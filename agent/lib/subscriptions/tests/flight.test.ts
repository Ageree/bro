import { afterEach, describe, expect, it, vi } from "vitest";
import type * as routesModule from "@agent/lib/routes/openstreetmap";

const routes = vi.hoisted(() => ({
  findPlaces: vi.fn<typeof routesModule.findPlaces>(),
  measureRoutes: vi.fn<typeof routesModule.measureRoutes>(),
}));
vi.mock("@agent/lib/routes/openstreetmap", async (importOriginal) => ({
  ...(await importOriginal<typeof routesModule>()),
  findPlaces: routes.findPlaces,
  measureRoutes: routes.measureRoutes,
}));

import {
  dueFlightStages,
  flightFacts,
  flightReminderSignals,
  measureDrive,
} from "@agent/lib/subscriptions/flight";

afterEach(() => {
  vi.clearAllMocks();
});

const moscow = "Europe/Moscow";
// DP 405, 07:05 Moscow on Sunday 4 October.
const departure = new Date("2026-10-04T04:05:00.000Z");
const at = (iso: string) => new Date(iso);
const due = (
  now: string,
  done: readonly ("checkin" | "evening")[] = [],
  flightZone = moscow,
  personZone = moscow,
  leaves = departure
) =>
  dueFlightStages({
    departure: leaves,
    done,
    flightZone,
    now: at(now),
    personZone,
  });

describe("a flight's reminders by the clock", () => {
  it("reminds of check-in by day once it opens, and of the flight in the evening", () => {
    // 09:00 the day before: check-in opened at 07:05.
    expect(due("2026-10-03T06:00:00.000Z")).toEqual(["checkin"]);
    // 19:00 the day before: both, unless one already went.
    expect(due("2026-10-03T16:00:00.000Z").toSorted()).toEqual([
      "checkin",
      "evening",
    ]);
    expect(due("2026-10-03T16:00:00.000Z", ["checkin"])).toEqual(["evening"]);
  });

  it("never reminds of check-in in the person's quiet hours", () => {
    // 07:30 the day before: check-in is open, but it is night for them.
    expect(due("2026-10-03T04:30:00.000Z")).toEqual([]);
    // 23:30 the evening before: too late for the evening, night for
    // check-in.
    expect(due("2026-10-03T20:30:00.000Z")).toEqual([]);
    // Three hours before departure the person is on the way.
    expect(due("2026-10-04T01:30:00.000Z")).toEqual([]);
  });

  it("has no evening reminder for a flight after noon", () => {
    expect(
      due(
        "2026-10-03T16:00:00.000Z",
        [],
        moscow,
        moscow,
        at("2026-10-04T12:30:00.000Z")
      )
    ).not.toContain("evening");
  });

  it("counts the evening on the clock of the city the flight leaves", () => {
    // 06:00 in Novosibirsk (UTC+7) is 02:00 in Moscow. The evening before is
    // Novosibirsk's: 18:00 there is 14:00 in Moscow.
    const novosibirsk = at("2026-10-03T23:00:00.000Z");
    expect(
      due(
        "2026-10-03T11:30:00.000Z",
        ["checkin"],
        "Asia/Novosibirsk",
        moscow,
        novosibirsk
      )
    ).toEqual(["evening"]);
    expect(
      due(
        "2026-10-03T10:30:00.000Z",
        ["checkin"],
        "Asia/Novosibirsk",
        moscow,
        novosibirsk
      )
    ).toEqual([]);
  });

  it("counts the evening across a DST change", () => {
    // Berlin leaves summer time on 25 October 2026: 18:00 the evening before
    // a 07:00 flight on the 26th is 17:00 UTC.
    const berlin = "Europe/Berlin";
    const leaves = at("2026-10-26T06:00:00.000Z");
    expect(
      due("2026-10-25T16:30:00.000Z", ["checkin"], berlin, berlin, leaves)
    ).toEqual([]);
    expect(
      due("2026-10-25T17:00:00.000Z", ["checkin"], berlin, berlin, leaves)
    ).toEqual(["evening"]);
  });

  it("keys a due reminder as the proactive check's own", () => {
    expect(
      flightReminderSignals(
        [
          {
            id: "w1",
            source: {
              eventId: "dp405",
              location: "Аэропорт Внуково",
              start: "2026-10-04T07:05:00+03:00",
              summary: "Рейс DP 405",
              timeZone: moscow,
            },
            state: { done: [] },
          },
        ],
        at("2026-10-03T06:00:00.000Z"),
        moscow
      )
    ).toEqual([
      {
        signal: {
          dedupeKey: "dp405@2026-10-04T07:05:00+03:00#checkin",
          itemId: "dp405",
          source: "calendar",
          threadId: null,
        },
        stage: "checkin",
        watchId: "w1",
      },
    ]);
  });
});

const watch = {
  source: {
    eventId: "flight-1",
    location: "Аэропорт Внуково (VKO), терминал A",
    start: "2026-10-04T07:05:00+03:00",
    summary: "Рейс DP 405 Москва (Внуково) — Сочи",
    timeZone: moscow,
  },
  state: {
    done: [],
    travel: {
      from: "home" as const,
      kind: "drive" as const,
      km: 31.4,
      minutes: 42,
      to: "Внуково",
    },
  },
};

const noHome = {
  addressLine1: null,
  addressLine2: null,
  city: "Москва",
  region: null,
};

function place(name: string, lat: number, lon: number, tag?: string) {
  return {
    countryCode: "ru",
    district: undefined,
    houseNumber: undefined,
    importance: 0.5,
    kind: "place" as const,
    label: name,
    lat,
    lon,
    name,
    tag,
  };
}

describe("a flight's facts, counted by code", () => {
  it("names the departure, the usual check-in opening and a leave-by estimate", () => {
    const facts = flightFacts(watch, moscow) ?? "";
    expect(facts).toContain("Departs 2026-10-04 07:05, Sunday (Europe/Moscow)");
    expect(facts).toContain(
      "Online check-in usually opens about 24 h before, 2026-10-03 07:05, Saturday (Europe/Moscow), but airlines differ"
    );
    // 07:05 − about 2 h at the airport − 42 min by car.
    expect(facts).toContain("A leave-by estimate: about 2026-10-04 04:23");
    expect(facts).toContain(
      "42 min (31.4 km) by car without traffic from home to «Внуково»"
    );
    expect(facts).not.toMatch(/use these times as they are|check-in is open/u);
  });

  it("names the times where the flight leaves and on the person's clock", () => {
    const facts =
      flightFacts(
        {
          ...watch,
          source: { ...watch.source, timeZone: "Asia/Novosibirsk" },
        },
        moscow
      ) ?? "";
    expect(facts).toContain(
      "Departs 2026-10-04 11:05, Sunday (Asia/Novosibirsk); 2026-10-04 07:05, Sunday (Europe/Moscow) on the person's own clock"
    );
  });

  it("counts no leave-by time from another city or without a drive", () => {
    expect(
      flightFacts(
        { ...watch, state: { done: [], travel: { kind: "elsewhere" } } },
        moscow
      )
    ).toContain("leaves from another city: no leave-by time");
    expect(flightFacts({ ...watch, state: { done: [] } }, moscow)).toContain(
      "give no leave-by time"
    );
  });

  it("measures the drive from home to the aerodrome the event names", async () => {
    routes.findPlaces
      .mockResolvedValueOnce([place("дом", 55.75, 37.6)])
      .mockResolvedValueOnce([
        // «Аэропорт» is also a metro station; only the aerodrome counts.
        place("Аэропорт", 55.8, 37.53, "railway:station"),
        place("Внуково", 55.6, 37.27, "aeroway:aerodrome"),
      ]);
    routes.measureRoutes.mockResolvedValue([{ km: 31.4, minutes: 42 }]);
    await expect(
      measureDrive(
        watch,
        { ...noHome, addressLine1: "ул. Профсоюзная, 12" },
        new AbortController().signal
      )
    ).resolves.toEqual({
      from: "home",
      kind: "drive",
      km: 31.4,
      minutes: 42,
      to: "Внуково",
    });
    // The terminal and the code are no part of the airport's name.
    expect(routes.findPlaces.mock.calls[1]?.[0]).toBe("Аэропорт Внуково");
    expect(routes.measureRoutes.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ tag: "aeroway:aerodrome" }),
    ]);
  });

  it("calls an airport of another city elsewhere, and counts no drive", async () => {
    routes.findPlaces
      .mockResolvedValueOnce([place("Москва", 55.75, 37.6)])
      .mockResolvedValueOnce([
        place("Толмачёво", 55.01, 82.65, "aeroway:aerodrome"),
      ]);
    await expect(
      measureDrive(watch, noHome, new AbortController().signal)
    ).resolves.toEqual({ kind: "elsewhere" });
    expect(routes.measureRoutes).not.toHaveBeenCalled();
  });

  it("measures nothing, to try again later, without an aerodrome, a place or a map", async () => {
    await expect(
      measureDrive(
        { source: { ...watch.source, location: null } },
        noHome,
        new AbortController().signal
      )
    ).resolves.toBeUndefined();
    expect(routes.findPlaces).not.toHaveBeenCalled();
    routes.findPlaces
      .mockResolvedValueOnce([place("Москва", 55.75, 37.6)])
      .mockResolvedValueOnce([place("м. Аэропорт", 55.8, 37.53)]);
    await expect(
      measureDrive(watch, noHome, new AbortController().signal)
    ).resolves.toBeUndefined();
    routes.findPlaces.mockRejectedValue(new Error("rate limited"));
    await expect(
      measureDrive(watch, noHome, new AbortController().signal)
    ).resolves.toBeUndefined();
  });
});

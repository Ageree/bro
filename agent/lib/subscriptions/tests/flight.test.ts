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
  flightFacts,
  flightPlan,
  measureDrive,
} from "@agent/lib/subscriptions/flight";

afterEach(() => {
  vi.clearAllMocks();
});

const moscow = "Europe/Moscow";
// DP 405, 07:05 Moscow on Saturday 4 October.
const departure = new Date("2026-10-04T04:05:00.000Z");
const at = (iso: string) => new Date(iso);

describe("a flight's reminders by the clock", () => {
  it("reminds of check-in in the morning and of the flight in the evening", () => {
    // Check-in opens at 07:05 the day before, inside the quiet hours: it
    // waits for 08:00. The evening reminder waits for 18:00.
    expect(
      flightPlan({
        departure,
        done: [],
        now: at("2026-10-03T03:00:00.000Z"),
        timeZone: moscow,
      })
    ).toEqual({ due: [], next: at("2026-10-03T05:00:00.000Z") });
    expect(
      flightPlan({
        departure,
        done: [],
        now: at("2026-10-03T06:00:00.000Z"),
        timeZone: moscow,
      })
    ).toEqual({ due: ["checkin"], next: at("2026-10-03T15:00:00.000Z") });
    expect(
      flightPlan({
        departure,
        done: ["checkin"],
        now: at("2026-10-03T15:30:00.000Z"),
        timeZone: moscow,
      })
    ).toEqual({ due: ["evening"], next: undefined });
  });

  it("never hands check-in over at night, and lets it go if the night outlasts it", () => {
    // A 14:00 flight seen at 23:30: its check-in waits for 08:00.
    expect(
      flightPlan({
        departure: at("2026-10-04T11:00:00.000Z"),
        done: [],
        now: at("2026-10-03T20:30:00.000Z"),
        timeZone: moscow,
      })
    ).toEqual({ due: [], next: at("2026-10-04T05:00:00.000Z") });
  });

  it("hands both over at once to a flight first seen in the evening", () => {
    expect(
      flightPlan({
        departure,
        done: [],
        now: at("2026-10-03T16:00:00.000Z"),
        timeZone: moscow,
      }).due.toSorted()
    ).toEqual(["checkin", "evening"]);
  });

  it("lets a window pass without a word once it is over", () => {
    // 23:30 the evening before: too late to write about tomorrow's flight,
    // and check-in, whose window ends at 04:05, is no news at night.
    expect(
      flightPlan({
        departure,
        done: [],
        now: at("2026-10-03T20:30:00.000Z"),
        timeZone: moscow,
      })
    ).toEqual({ due: [], next: undefined });
    // Three hours before departure the person is on the way.
    expect(
      flightPlan({
        departure,
        done: [],
        now: at("2026-10-04T01:30:00.000Z"),
        timeZone: moscow,
      })
    ).toEqual({ due: [], next: undefined });
  });

  it("has no evening reminder for a flight after noon", () => {
    const afternoon = new Date("2026-10-04T12:30:00.000Z");
    expect(
      flightPlan({
        departure: afternoon,
        done: [],
        // 13:00 the day before: only check-in lies ahead, at 15:30.
        now: at("2026-10-03T10:00:00.000Z"),
        timeZone: moscow,
      })
    ).toEqual({ due: [], next: at("2026-10-03T12:30:00.000Z") });
  });

  it("counts the evening on the person's own clock across a DST change", () => {
    // Berlin leaves summer time on 25 October 2026: the evening before a
    // 07:00 flight on the 26th is still 18:00 local, now at 17:00 UTC.
    expect(
      flightPlan({
        departure: at("2026-10-26T06:00:00.000Z"),
        done: ["checkin"],
        now: at("2026-10-25T16:30:00.000Z"),
        timeZone: "Europe/Berlin",
      })
    ).toEqual({ due: [], next: at("2026-10-25T17:00:00.000Z") });
  });
});

const watch = {
  source: {
    eventId: "flight-1",
    location: "Аэропорт Внуково (VKO), терминал A",
    start: "2026-10-04T07:05:00+03:00",
    summary: "Рейс DP 405 Москва (Внуково) — Сочи",
  },
  state: {
    done: [],
    travel: { from: "home" as const, km: 31.4, minutes: 42, to: "Внуково" },
  },
};

function place(name: string, lat: number, lon: number) {
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
    tag: undefined,
  };
}

describe("a flight's facts, counted by code", () => {
  it("names the departure, the check-in opening and when to leave, on the person's clock", () => {
    const facts = flightFacts(watch, moscow) ?? "";
    expect(facts).toContain("Departs 2026-10-04 07:05, Sunday (Europe/Moscow)");
    expect(facts).toContain("2026-10-03 07:05, Saturday (Europe/Moscow)");
    // 07:05 − 2 h at the airport − 42 min by car.
    expect(facts).toContain("Leave home by about 2026-10-04 04:23");
    expect(facts).toContain(
      "42 min (31.4 km) by car without traffic from home to «Внуково»"
    );
  });

  it("asks the worker to count the drive itself when code could not", () => {
    expect(
      flightFacts({ ...watch, state: { done: [], travel: null } }, moscow)
    ).toContain("could not be measured");
  });

  it("measures the drive from home to the airport the event names", async () => {
    routes.findPlaces
      .mockResolvedValueOnce([place("дом", 55.75, 37.6)])
      .mockResolvedValueOnce([place("Внуково", 55.6, 37.27)]);
    routes.measureRoutes.mockResolvedValue([{ km: 31.4, minutes: 42 }]);
    await expect(
      measureDrive(
        watch,
        {
          addressLine1: "ул. Профсоюзная, 12",
          addressLine2: null,
          city: "Москва",
          region: null,
        },
        new AbortController().signal
      )
    ).resolves.toEqual({ from: "home", km: 31.4, minutes: 42, to: "Внуково" });
    // The terminal and the code are no part of the airport's name.
    expect(routes.findPlaces.mock.calls[1]?.[0]).toBe("Аэропорт Внуково");
  });

  it("measures nothing to an airport the event does not name", async () => {
    await expect(
      measureDrive(
        { source: { ...watch.source, location: null } },
        {
          addressLine1: null,
          addressLine2: null,
          city: "Москва",
          region: null,
        },
        new AbortController().signal
      )
    ).resolves.toBeNull();
    expect(routes.findPlaces).not.toHaveBeenCalled();
  });

  it("measures nothing without a start, or from an airport found far away", async () => {
    await expect(
      measureDrive(
        watch,
        { addressLine1: null, addressLine2: null, city: null, region: null },
        new AbortController().signal
      )
    ).resolves.toBeNull();
    routes.findPlaces
      .mockResolvedValueOnce([place("Москва", 55.75, 37.6)])
      .mockResolvedValueOnce([place("Внуково, Калмыкия", 46.3, 44.3)]);
    await expect(
      measureDrive(
        watch,
        {
          addressLine1: null,
          addressLine2: null,
          city: "Москва",
          region: null,
        },
        new AbortController().signal
      )
    ).resolves.toBeNull();
    expect(routes.measureRoutes).not.toHaveBeenCalled();
  });

  it("measures nothing when the map fails, without failing the check", async () => {
    routes.findPlaces.mockRejectedValue(new Error("rate limited"));
    await expect(
      measureDrive(
        watch,
        {
          addressLine1: null,
          addressLine2: null,
          city: "Москва",
          region: null,
        },
        new AbortController().signal
      )
    ).resolves.toBeNull();
  });
});

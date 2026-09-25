import { describe, expect, it } from "vitest";
import {
  computeLatestRun,
  computeNextRun,
  localRunLabel,
  resolveScheduleTiming,
  scheduleTimingInputSchema,
  scheduleTimingSchema,
  storedScheduleTimingSchema,
  type ScheduleTiming,
} from "@shared/schedules/timing";

const moscow = "Europe/Moscow";

/** Every occurrence after `from`, as ISO strings. */
function occurrences(timing: ScheduleTiming, from: string, count: number) {
  const runs: string[] = [];
  let after = new Date(from);
  for (let index = 0; index < count; index += 1) {
    const next = computeNextRun(timing, after);
    if (!next) break;
    runs.push(next.toISOString());
    after = next;
  }
  return runs;
}

describe("schedule timing", () => {
  it("finds the latest elapsed interval without walking every occurrence", () => {
    expect(
      computeLatestRun(
        {
          anchoredAt: "2026-09-01T13:00:00.000Z",
          everyMinutes: 60,
          kind: "interval",
        },
        new Date("2026-09-08T13:30:00.000Z")
      )
    ).toEqual(new Date("2026-09-08T13:00:00.000Z"));
  });

  it("keeps calendar recurrence at the same local time across DST", () => {
    const timing = {
      frequency: "daily" as const,
      kind: "calendar" as const,
      localTime: "09:00",
      timezone: "America/New_York",
    };

    expect(
      computeNextRun(
        timing,
        new Date("2026-10-31T14:00:00.000Z")
      )?.toISOString()
    ).toBe("2026-11-01T14:00:00.000Z");
    expect(
      computeNextRun(
        timing,
        new Date("2026-11-01T15:00:00.000Z")
      )?.toISOString()
    ).toBe("2026-11-02T14:00:00.000Z");
  });

  it("anchors intervals instead of drifting from completion time", () => {
    expect(
      computeNextRun(
        {
          anchoredAt: "2026-09-01T12:00:00.000Z",
          everyMinutes: 60,
          kind: "interval",
        },
        new Date("2026-09-01T13:07:00.000Z")
      )?.toISOString()
    ).toBe("2026-09-01T14:00:00.000Z");
  });

  it("requires weekdays for weekly calendar recurrence", () => {
    expect(
      scheduleTimingSchema.safeParse({
        frequency: "weekly",
        kind: "calendar",
        localTime: "09:00",
        timezone: "America/New_York",
      }).success
    ).toBe(false);
  });
});

describe("monthly and yearly calendar rules", () => {
  it("runs on the 5th of every month at 10:00 local time", () => {
    // «Напоминай каждое 5-е число в 10 утра».
    const timing = scheduleTimingSchema.parse({
      dayOfMonth: 5,
      frequency: "monthly",
      kind: "calendar",
      localTime: "10:00",
      timezone: moscow,
    });

    expect(occurrences(timing, "2026-09-24T12:00:00.000Z", 6)).toEqual([
      "2026-10-05T07:00:00.000Z",
      "2026-11-05T07:00:00.000Z",
      "2026-12-05T07:00:00.000Z",
      "2027-01-05T07:00:00.000Z",
      "2027-02-05T07:00:00.000Z",
      "2027-03-05T07:00:00.000Z",
    ]);
    // Later on the 5th itself, the next one is a month away; earlier, today.
    expect(
      computeNextRun(timing, new Date("2026-10-05T07:00:00.000Z"))
    ).toEqual(new Date("2026-11-05T07:00:00.000Z"));
    expect(
      computeNextRun(timing, new Date("2026-10-05T06:59:00.000Z"))
    ).toEqual(new Date("2026-10-05T07:00:00.000Z"));
    expect(
      computeLatestRun(timing, new Date("2026-10-20T00:00:00.000Z"))
    ).toEqual(new Date("2026-10-05T07:00:00.000Z"));
  });

  it("moves the 31st to the last day of shorter months, then back", () => {
    const timing = scheduleTimingSchema.parse({
      dayOfMonth: 31,
      frequency: "monthly",
      kind: "calendar",
      localTime: "09:00",
      timezone: "UTC",
    });

    expect(occurrences(timing, "2027-01-01T00:00:00.000Z", 5)).toEqual([
      "2027-01-31T09:00:00.000Z",
      "2027-02-28T09:00:00.000Z",
      "2027-03-31T09:00:00.000Z",
      "2027-04-30T09:00:00.000Z",
      "2027-05-31T09:00:00.000Z",
    ]);
    // A leap February has its 29th.
    expect(
      computeNextRun(timing, new Date("2028-02-01T00:00:00.000Z"))
    ).toEqual(new Date("2028-02-29T09:00:00.000Z"));
    expect(
      computeLatestRun(timing, new Date("2027-03-15T00:00:00.000Z"))
    ).toEqual(new Date("2027-02-28T09:00:00.000Z"));
  });

  it("runs on the last day of each month", () => {
    const timing = scheduleTimingSchema.parse({
      dayOfMonth: "last",
      frequency: "monthly",
      kind: "calendar",
      localTime: "18:30",
      timezone: moscow,
    });

    expect(occurrences(timing, "2027-01-31T20:00:00.000Z", 4)).toEqual([
      "2027-02-28T15:30:00.000Z",
      "2027-03-31T15:30:00.000Z",
      "2027-04-30T15:30:00.000Z",
      "2027-05-31T15:30:00.000Z",
    ]);
  });

  it("runs on the second Sunday and on the last Friday of the month", () => {
    const secondSunday = scheduleTimingSchema.parse({
      frequency: "monthly_weekday",
      kind: "calendar",
      localTime: "11:00",
      occurrence: 2,
      timezone: moscow,
      weekday: 0,
    });
    const lastFriday = scheduleTimingSchema.parse({
      frequency: "monthly_weekday",
      kind: "calendar",
      localTime: "11:00",
      occurrence: "last",
      timezone: moscow,
      weekday: 5,
    });

    expect(occurrences(secondSunday, "2026-09-24T00:00:00.000Z", 4)).toEqual([
      "2026-10-11T08:00:00.000Z",
      "2026-11-08T08:00:00.000Z",
      "2026-12-13T08:00:00.000Z",
      "2027-01-10T08:00:00.000Z",
    ]);
    expect(occurrences(lastFriday, "2026-09-24T00:00:00.000Z", 3)).toEqual([
      "2026-09-25T08:00:00.000Z",
      "2026-10-30T08:00:00.000Z",
      "2026-11-27T08:00:00.000Z",
    ]);
  });

  it("runs yearly, keeping 29 February on 28 February in common years", () => {
    const birthday = scheduleTimingSchema.parse({
      dayOfMonth: 29,
      frequency: "yearly",
      kind: "calendar",
      localTime: "09:00",
      month: 2,
      timezone: "UTC",
    });

    expect(occurrences(birthday, "2026-09-24T00:00:00.000Z", 3)).toEqual([
      "2027-02-28T09:00:00.000Z",
      "2028-02-29T09:00:00.000Z",
      "2029-02-28T09:00:00.000Z",
    ]);
    expect(
      scheduleTimingSchema.safeParse({
        dayOfMonth: 31,
        frequency: "yearly",
        kind: "calendar",
        localTime: "09:00",
        month: 4,
        timezone: "UTC",
      }).success
    ).toBe(false);
  });

  it("runs on chosen days of the week", () => {
    const timing = scheduleTimingSchema.parse({
      frequency: "weekly",
      kind: "calendar",
      localTime: "07:00",
      timezone: moscow,
      weekdays: [1, 4],
    });

    // 2026-09-24 is a Thursday.
    expect(occurrences(timing, "2026-09-24T05:00:00.000Z", 3)).toEqual([
      "2026-09-28T04:00:00.000Z",
      "2026-10-01T04:00:00.000Z",
      "2026-10-05T04:00:00.000Z",
    ]);
  });

  it("keeps the single weekday of weekly schedules stored before", () => {
    const timing = storedScheduleTimingSchema.parse({
      frequency: "weekly",
      kind: "calendar",
      localTime: "07:00",
      timezone: moscow,
      weekday: 1,
    });

    expect(occurrences(timing, "2026-09-24T05:00:00.000Z", 2)).toEqual([
      "2026-09-28T04:00:00.000Z",
      "2026-10-05T04:00:00.000Z",
    ]);
    expect(scheduleTimingSchema.safeParse(timing).success).toBe(false);
  });

  it("keeps a monthly run at 10:00 local across the DST change", () => {
    const timing = scheduleTimingSchema.parse({
      dayOfMonth: 5,
      frequency: "monthly",
      kind: "calendar",
      localTime: "10:00",
      timezone: "Europe/Berlin",
    });

    // Berlin is UTC+2 on 5 October and UTC+1 on 5 November.
    expect(occurrences(timing, "2026-09-24T00:00:00.000Z", 2)).toEqual([
      "2026-10-05T08:00:00.000Z",
      "2026-11-05T09:00:00.000Z",
    ]);
  });

  it("fires a time skipped by the spring-forward gap an hour later", () => {
    const timing = scheduleTimingSchema.parse({
      frequency: "monthly_weekday",
      kind: "calendar",
      localTime: "02:30",
      occurrence: "last",
      timezone: "Europe/Berlin",
      weekday: 0,
    });

    // 02:30 does not exist in Berlin on 28 March 2027.
    expect(
      computeNextRun(timing, new Date("2027-03-01T00:00:00.000Z"))
    ).toEqual(new Date("2027-03-28T01:30:00.000Z"));
  });

  it("shifts a skipped time by the gap itself where it is half an hour", () => {
    const timing = scheduleTimingSchema.parse({
      frequency: "monthly_weekday",
      kind: "calendar",
      localTime: "02:15",
      occurrence: 1,
      timezone: "Australia/Lord_Howe",
      weekday: 0,
    });

    // Lord Howe goes from +10:30 to +11:00 at 02:00 on 4 October 2026, so
    // 02:15 is skipped and fires at 02:45 local.
    expect(
      computeNextRun(timing, new Date("2026-09-24T00:00:00.000Z"))
    ).toEqual(new Date("2026-10-03T15:45:00.000Z"));
  });

  it("follows the person to a new timezone at the same wall-clock time", () => {
    const inMoscow = scheduleTimingSchema.parse({
      dayOfMonth: 5,
      frequency: "monthly",
      kind: "calendar",
      localTime: "10:00",
      timezone: moscow,
    });
    const inYekaterinburg = { ...inMoscow, timezone: "Asia/Yekaterinburg" };
    const after = new Date("2026-09-24T00:00:00.000Z");

    expect(computeNextRun(inMoscow, after)).toEqual(
      new Date("2026-10-05T07:00:00.000Z")
    );
    expect(computeNextRun(inYekaterinburg, after)).toEqual(
      new Date("2026-10-05T05:00:00.000Z")
    );
  });

  it("takes the calendar date of the rule's own timezone", () => {
    // 22:00 UTC on 4 October is already the 5th in Tokyo.
    const timing = scheduleTimingSchema.parse({
      dayOfMonth: 5,
      frequency: "monthly",
      kind: "calendar",
      localTime: "10:00",
      timezone: "Asia/Tokyo",
    });

    expect(
      computeNextRun(timing, new Date("2026-10-04T22:00:00.000Z"))
    ).toEqual(new Date("2026-10-05T01:00:00.000Z"));
  });

  it("refuses a month or a year expressed as minutes", () => {
    for (const days of [30, 31, 365]) {
      expect(
        scheduleTimingSchema.safeParse({
          anchoredAt: "2026-10-05T07:00:00.000Z",
          everyMinutes: days * 1_440,
          kind: "interval",
        }).success
      ).toBe(false);
    }
    expect(
      scheduleTimingSchema.safeParse({
        anchoredAt: "2026-10-05T07:00:00.000Z",
        everyMinutes: 2 * 1_440,
        kind: "interval",
      }).success
    ).toBe(true);
    // Schedules stored that way before keep running.
    expect(
      storedScheduleTimingSchema.safeParse({
        anchoredAt: "2026-10-05T07:00:00.000Z",
        everyMinutes: 43_200,
        kind: "interval",
      }).success
    ).toBe(true);
  });
});

function weekdays(timezone: string, skipHolidays?: true) {
  return scheduleTimingSchema.parse({
    frequency: "weekdays",
    kind: "calendar",
    localTime: "08:00",
    skipHolidays,
    timezone,
  });
}

describe("holidays, only when the person asked", () => {
  it("keeps a weekday rule firing on a holiday unless told otherwise", () => {
    // 4 November 2026, День народного единства, is a Wednesday. A weekday
    // pill reminder stored before the flag existed still fires on it.
    expect(
      occurrences(weekdays("Asia/Yekaterinburg"), "2026-11-03T04:00:00Z", 1)
    ).toEqual(["2026-11-04T03:00:00.000Z"]);
    expect(
      occurrences(
        weekdays("Asia/Yekaterinburg", true),
        "2026-11-02T04:00:00Z",
        3
      )
    ).toEqual([
      "2026-11-03T03:00:00.000Z",
      "2026-11-05T03:00:00.000Z",
      "2026-11-06T03:00:00.000Z",
    ]);
    // Outside Russia nothing is known, so a Wednesday is a Wednesday.
    expect(
      occurrences(weekdays("America/New_York", true), "2026-11-03T14:00:00Z", 1)
    ).toEqual(["2026-11-04T13:00:00.000Z"]);
  });

  it("waits out the New Year break and the decree's moved days", () => {
    // 31 December 2026 and 1–8 January 2027 are off; Monday the 11th works.
    expect(
      occurrences(weekdays(moscow, true), "2026-12-30T06:00:00Z", 1)
    ).toEqual(["2027-01-11T05:00:00.000Z"]);
    // 9 January 2026 was moved off by decree No. 1466; the first run is the 12th.
    expect(
      occurrences(weekdays(moscow, true), "2025-12-31T06:00:00Z", 1)
    ).toEqual(["2026-01-12T05:00:00.000Z"]);
    // 8 March 2026 is a Sunday, so Monday the 9th is off instead.
    expect(
      occurrences(weekdays(moscow, true), "2026-03-06T06:00:00Z", 1)
    ).toEqual(["2026-03-10T05:00:00.000Z"]);
  });

  it("keeps a daily digest off the holiday itself, weekend or not", () => {
    const daily = scheduleTimingSchema.parse({
      frequency: "daily",
      kind: "calendar",
      localTime: "08:00",
      skipHolidays: true,
      timezone: moscow,
    });
    // Saturday 7 March runs; Sunday the 8th and the moved Monday do not.
    expect(occurrences(daily, "2026-03-06T06:00:00Z", 2)).toEqual([
      "2026-03-07T05:00:00.000Z",
      "2026-03-10T05:00:00.000Z",
    ]);
  });
});

describe("what the schedule tools accept", () => {
  it("fills a missing zone from the person's profile", () => {
    const input = scheduleTimingInputSchema.parse({
      frequency: "daily",
      kind: "calendar",
      localTime: "07:30",
    });
    expect(resolveScheduleTiming(input, "Asia/Yekaterinburg")).toEqual({
      frequency: "daily",
      kind: "calendar",
      localTime: "07:30",
      timezone: "Asia/Yekaterinburg",
    });
    // A zone the person asked for stays.
    expect(
      resolveScheduleTiming(
        scheduleTimingInputSchema.parse({
          frequency: "daily",
          kind: "calendar",
          localTime: "07:30",
          timezone: "America/New_York",
        }),
        moscow
      )
    ).toMatchObject({ timezone: "America/New_York" });
  });

  it("stores skipHolidays only when the person asked for it", () => {
    const rule = {
      frequency: "weekdays",
      kind: "calendar",
      localTime: "08:00",
    };
    expect(
      resolveScheduleTiming(
        scheduleTimingInputSchema.parse({ ...rule, skipHolidays: false }),
        moscow
      )
    ).toEqual({ ...rule, timezone: moscow });
    expect(
      resolveScheduleTiming(
        scheduleTimingInputSchema.parse({ ...rule, skipHolidays: true }),
        moscow
      )
    ).toEqual({ ...rule, skipHolidays: true, timezone: moscow });
    // A monthly rule has no holidays to step over.
    expect(
      scheduleTimingInputSchema.safeParse({
        dayOfMonth: 5,
        frequency: "monthly",
        kind: "calendar",
        localTime: "10:00",
        skipHolidays: true,
      }).success
    ).toBe(false);
  });

  it("reads a one-off wall-clock time in the zone and keeps an exact instant", () => {
    expect(
      resolveScheduleTiming(
        scheduleTimingInputSchema.parse({
          at: "2026-09-26T09:00",
          kind: "once",
        }),
        moscow
      )
    ).toEqual({ at: "2026-09-26T06:00:00.000Z", kind: "once" });
    expect(
      resolveScheduleTiming(
        scheduleTimingInputSchema.parse({
          at: "2026-09-26T09:00",
          kind: "once",
          timezone: "Europe/Berlin",
        }),
        moscow
      )
    ).toEqual({ at: "2026-09-26T07:00:00.000Z", kind: "once" });
    expect(
      resolveScheduleTiming(
        scheduleTimingInputSchema.parse({
          at: "2099-01-15T15:00:00Z",
          kind: "once",
        }),
        moscow
      )
    ).toEqual({ at: "2099-01-15T15:00:00Z", kind: "once" });
    expect(
      scheduleTimingInputSchema.safeParse({ at: "завтра в 9", kind: "once" })
        .success
    ).toBe(false);
  });

  it("names a run on the person's clock", () => {
    expect(
      localRunLabel(new Date("2026-09-28T03:00:00.000Z"), "Asia/Yekaterinburg")
    ).toBe("2026-09-28 08:00, Monday (Asia/Yekaterinburg)");
  });
});

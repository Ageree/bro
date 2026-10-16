import { describe, expect, it } from "vitest";
import type { ScheduleTiming } from "@shared/schedules/timing";
import { similarSchedules } from "@agent/lib/schedules/routine";

const zone = "Asia/Yekaterinburg";

function calendar(
  frequency: "daily" | "weekdays",
  localTime: string
): ScheduleTiming {
  return { frequency, kind: "calendar", localTime, timezone: zone };
}

function weekly(weekday: number, localTime: string): ScheduleTiming {
  return {
    frequency: "weekly",
    kind: "calendar",
    localTime,
    timezone: zone,
    weekdays: [weekday],
  };
}

function job(
  prompt: string,
  timing: ScheduleTiming,
  status: "active" | "paused" = "active"
) {
  return { id: prompt, prompt, status, timing };
}

const ruSummary = job(
  "Утренняя сводка: что сегодня в календаре, на какие письма я ещё не ответил, погода и сколько ехать до работы на машине.",
  calendar("weekdays", "08:00")
);

describe("schedules a new routine repeats", () => {
  // EN D7: the person's morning summary was made a second time.
  it("finds the same summary asked for again near its time", () => {
    expect(
      similarSchedules(
        {
          prompt:
            "Каждый будний день присылай сводку: календарь на день, письма без ответа и погоду.",
          timing: calendar("weekdays", "07:00"),
        },
        [ruSummary]
      )
    ).toEqual([ruSummary]);
  });

  it("takes neither the same time nor the same words alone for a repeat", () => {
    // «В 8:00 омепразол, в 8:30 эналаприл»: two reminders.
    const omeprazole = job(
      "Напомнить выпить омепразол.",
      calendar("daily", "08:00")
    );
    expect(
      similarSchedules(
        {
          prompt: "Напомнить выпить эналаприл.",
          timing: calendar("daily", "08:30"),
        },
        [omeprazole]
      )
    ).toEqual([]);
    // The evening summary is not the morning one.
    expect(
      similarSchedules(
        {
          prompt:
            "Каждый вечер присылай сводку: календарь на завтра, письма без ответа и погоду.",
          timing: calendar("daily", "20:00"),
        },
        [ruSummary]
      )
    ).toEqual([]);
  });

  it("measures the time across midnight between days, not within one", () => {
    const late = job("Пришли курс доллара и евро.", weekly(1, "23:30"));
    // Monday 23:30 and Tuesday 00:10 are 40 minutes apart.
    expect(
      similarSchedules({ prompt: late.prompt, timing: weekly(2, "00:10") }, [
        late,
      ])
    ).toEqual([late]);
    // Monday 00:10 and Monday 23:30 are almost a day apart.
    expect(
      similarSchedules({ prompt: late.prompt, timing: weekly(1, "00:10") }, [
        late,
      ])
    ).toEqual([]);
  });

  it("holds no one-off reminder, and counts no paused schedule", () => {
    expect(
      similarSchedules(
        {
          prompt: ruSummary.prompt,
          timing: { at: "2026-10-16T03:00:00.000Z", kind: "once" },
        },
        [ruSummary]
      )
    ).toEqual([]);
    expect(
      similarSchedules({ prompt: ruSummary.prompt, timing: ruSummary.timing }, [
        { ...ruSummary, status: "paused" },
      ])
    ).toEqual([]);
  });
});

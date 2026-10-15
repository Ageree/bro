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

describe("schedules like a new routine", () => {
  // EN D7: the person's morning summary was made a second time.
  it("finds a summary at a near time of the same days, in any language", () => {
    expect(
      similarSchedules(
        {
          prompt:
            "Every weekday send my calendar for the day, emails I still owe a reply to, and the weather.",
          timing: calendar("weekdays", "07:00"),
        },
        [ruSummary]
      )
    ).toEqual([ruSummary]);
  });

  it("finds the same summary asked for at another time", () => {
    expect(
      similarSchedules(
        {
          prompt:
            "Каждый вечер присылай сводку: календарь на завтра, письма без ответа и погоду.",
          timing: calendar("daily", "20:00"),
        },
        [ruSummary]
      )
    ).toEqual([ruSummary]);
  });

  it("leaves other work at another time, and runs on other days, alone", () => {
    const water = job("Напоминай пить воду.", calendar("daily", "11:00"));
    const rent = job("Напомни оплатить квартиру.", {
      dayOfMonth: 5,
      frequency: "monthly",
      kind: "calendar",
      localTime: "08:00",
      timezone: zone,
    });
    const saturday = job("Пришли список покупок на неделю.", {
      frequency: "weekly",
      kind: "calendar",
      localTime: "08:30",
      timezone: zone,
      weekdays: [6],
    });
    expect(
      similarSchedules(
        {
          prompt: "Каждое утро присылай курс доллара и евро.",
          timing: calendar("weekdays", "08:00"),
        },
        [water, rent, saturday]
      )
    ).toEqual([]);
    // Words in common that name different work are not the same routine.
    expect(
      similarSchedules(
        {
          prompt: "Напоминай пить таблетки.",
          timing: calendar("daily", "15:00"),
        },
        [water]
      )
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

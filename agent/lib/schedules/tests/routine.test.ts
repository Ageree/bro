import type { ModelMessage, ToolResultPart } from "ai";
import { describe, expect, it } from "vitest";
import type { ScheduleTiming } from "@shared/schedules/timing";
import {
  routineAnswerOwed,
  similarRefusalOpening,
  similarSchedules,
} from "@agent/lib/schedules/routine";

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
        [ruSummary],
        true
      )
    ).toEqual({ alike: [ruSummary], nearby: [] });
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
        [omeprazole],
        false
      )
    ).toEqual({ alike: [], nearby: [] });
    // The evening summary is not the morning one.
    expect(
      similarSchedules(
        {
          prompt:
            "Каждый вечер присылай сводку: календарь на завтра, письма без ответа и погоду.",
          timing: calendar("daily", "20:00"),
        },
        [ruSummary],
        true
      )
    ).toEqual({ alike: [], nearby: [] });
  });

  it("measures the time across midnight between days, not within one", () => {
    const late = job("Пришли курс доллара и евро.", weekly(1, "23:30"));
    // Monday 23:30 and Tuesday 00:10 are 40 minutes apart.
    expect(
      similarSchedules(
        { prompt: late.prompt, timing: weekly(2, "00:10") },
        [late],
        true
      ).alike
    ).toEqual([late]);
    // Monday 00:10 and Monday 23:30 are almost a day apart.
    expect(
      similarSchedules(
        { prompt: late.prompt, timing: weekly(1, "00:10") },
        [late],
        true
      )
    ).toEqual({ alike: [], nearby: [] });
  });

  it("holds no one-off reminder, and counts no paused schedule", () => {
    expect(
      similarSchedules(
        {
          prompt: ruSummary.prompt,
          timing: { at: "2026-10-16T03:00:00.000Z", kind: "once" },
        },
        [ruSummary],
        true
      )
    ).toEqual({ alike: [], nearby: [] });
    expect(
      similarSchedules(
        { prompt: ruSummary.prompt, timing: ruSummary.timing },
        [{ ...ruSummary, status: "paused" }],
        true
      )
    ).toEqual({ alike: [], nearby: [] });
  });

  // EN D7: the summary asked for in English shares no word with the Russian
  // one, so a new summary or check names the others at its time.
  it("names a schedule at the same time across languages for a summary only", () => {
    const enSummary = {
      prompt:
        "Every weekday send me a summary: today's calendar, unanswered emails and the weather.",
      timing: calendar("weekdays", "07:30"),
    };
    expect(similarSchedules(enSummary, [ruSummary], true)).toEqual({
      alike: [],
      nearby: [ruSummary],
    });
    // A reminder at that time is no summary to compare.
    expect(similarSchedules(enSummary, [ruSummary], false)).toEqual({
      alike: [],
      nearby: [],
    });
  });
});

function results(...content: ToolResultPart[]): ModelMessage {
  return { content, role: "tool" };
}

function person(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

describe("the person's answer about a schedule like theirs", () => {
  const refusal: ToolResultPart = {
    output: {
      type: "error-text",
      value: `${similarRefusalOpening} like this one: [].`,
    },
    toolCallId: "call-1",
    toolName: "schedules-create",
    type: "tool-result",
  };
  const delivered: ToolResultPart = {
    output: { type: "json", value: { kind: "message" } },
    toolCallId: "call-2",
    toolName: "send_message",
    type: "tool-result",
  };
  const sent = (text: string): ModelMessage[] => [
    {
      content: [
        {
          input: { kind: "message", text },
          toolCallId: "call-2",
          toolName: "send_message",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    results(delivered),
  ];

  it("is owed once the question reached the person, until they write", () => {
    const turn = [
      person("сделай утреннюю сводку"),
      results(refusal),
      ...sent("Такая сводка уже приходит в 8:00. Заменить её?"),
    ];
    expect(routineAnswerOwed(turn)).toBe(true);
    expect(routineAnswerOwed([...turn, person("замени")])).toBe(false);
  });

  it("is not owed before a question went out after the refusal", () => {
    expect(
      routineAnswerOwed([person("ещё одну сводку"), results(refusal)])
    ).toBe(false);
    expect(
      routineAnswerOwed([
        person("ещё одну сводку"),
        results(refusal),
        ...sent("Сейчас настрою."),
      ])
    ).toBe(false);
    // Sent in the refused call's own step, it was written before.
    expect(
      routineAnswerOwed([
        person("ещё одну сводку"),
        ...sent("Заменить её?").slice(0, 1),
        results(refusal, delivered),
      ])
    ).toBe(false);
  });
});

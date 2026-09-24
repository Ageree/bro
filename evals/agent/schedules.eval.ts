import { defineEval } from "eve/evals";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  agentEvalTags,
  assertPlainTextDelivery,
  requireDeliveredText,
} from "@evals/agent/shared";

const cases = [
  {
    description: "Creates a one-time reminder at an exact instant",
    expected: {
      missedRunPolicy: "run_latest",
      prompt: "Renew the library card.",
      timing: { at: "2099-01-15T15:00:00Z", kind: "once" },
    },
    prompt:
      "Create a one-time reminder for January 15, 2099 at 3:00 PM UTC. Use exactly 'Renew the library card.' as the reminder text.",
  },
  {
    description: "Creates a timezone-aware weekday reminder",
    expected: {
      missedRunPolicy: "run_latest",
      prompt: "Review my priorities.",
      timing: {
        frequency: "weekdays",
        kind: "calendar",
        localTime: "08:15",
        timezone: "America/New_York",
      },
    },
    prompt:
      "Create a recurring reminder every weekday at 8:15 AM America/New_York. Use exactly 'Review my priorities.' as the reminder text.",
  },
] as const;

// Month-based recurrence is a calendar rule in the person's timezone:
// «каждое 5-е» stored as 43 200 minutes drifted a day every 31-day month.
const calendarCases = [
  {
    description: "Keeps «каждое 5-е число» on the 5th, not every 30 days",
    prompt: "Напоминай каждое 5-е число в 10 утра оплатить квартиру.",
    timing: { dayOfMonth: 5, frequency: "monthly", localTime: "10:00" },
  },
  {
    description: "Runs on the last day of every month",
    prompt:
      "Каждый последний день месяца в 18:00 напоминай сдать показания счётчиков.",
    timing: { dayOfMonth: "last", frequency: "monthly", localTime: "18:00" },
  },
  {
    description: "Runs on the second Sunday of every month",
    prompt:
      "Каждое второе воскресенье месяца в 11 утра напоминай позвонить бабушке.",
    timing: {
      frequency: "monthly_weekday",
      localTime: "11:00",
      occurrence: 2,
      weekday: 0,
    },
  },
] as const;

const createdTimingSchema = z.object({
  timing: z.record(z.string(), z.unknown()),
});

const exactEvals = cases.map((testCase) =>
  defineEval({
    description: testCase.description,
    tags: [...agentEvalTags, "schedules"],
    async test(t) {
      const turn = await t.send(testCase.prompt);
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("schedules-create", {
        input: (input) => isDeepStrictEqual(input, testCase.expected),
        status: "completed",
        count: 1,
      });
      const text = await requireDeliveredText(t, turn);
      assertPlainTextDelivery(t, text);
    },
  })
);

const calendarEvals = calendarCases.map((testCase) =>
  defineEval({
    description: testCase.description,
    tags: [...agentEvalTags, "schedules"],
    async test(t) {
      const turn = await t.send(testCase.prompt);
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("schedules-create", {
        input: (input) => {
          const created = createdTimingSchema.safeParse(input);
          return (
            created.success &&
            created.data.timing.kind === "calendar" &&
            Object.entries(testCase.timing).every(([key, value]) =>
              isDeepStrictEqual(created.data.timing[key], value)
            )
          );
        },
        status: "completed",
        count: 1,
      });
      const text = await requireDeliveredText(t, turn);
      assertPlainTextDelivery(t, text);
    },
  })
);

export default [...exactEvals, ...calendarEvals];

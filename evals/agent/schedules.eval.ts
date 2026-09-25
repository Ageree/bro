import { defineEval } from "eve/evals";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  agentEvalTags,
  assertPlainTextDelivery,
  requireDeliveredText,
} from "@evals/agent/shared";
import {
  resolveScheduleTiming,
  scheduleTimingInputSchema,
} from "@shared/schedules/timing";

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
  {
    // RU d12, EN D7: the zone is the profile's, so the model names none.
    description: "Runs the morning digest on working days at 08:00",
    prompt:
      "Каждый будний день в 8 утра присылай: что у меня сегодня в календаре, на какие письма я ещё не ответил, погоду и сколько ехать до работы на машине.",
    timing: { frequency: "weekdays", localTime: "08:00" },
  },
  {
    // Holidays are skipped only on request: without it a reminder fires.
    description: "Keeps a weekday digest off holidays when asked",
    prompt:
      "По будням в 9 утра присылай курс доллара и евро, кроме праздников.",
    timing: { frequency: "weekdays", localTime: "09:00", skipHolidays: true },
  },
] as const;

/**
 * A zone no case asks for: a timing that leaves out the zone its request
 * named resolves here and misses the expected instant.
 */
const unrelatedZone = "Asia/Kamchatka";

/**
 * Whether the tool input, once stored, is the expected timing. A one-off may
 * name its moment on the wall clock or as an instant; what counts is when.
 */
function sameStoredTiming(
  input: z.infer<typeof scheduleTimingInputSchema> | undefined,
  expected: z.infer<typeof scheduleTimingInputSchema>
) {
  if (!input) return false;
  const stored = resolveScheduleTiming(input, unrelatedZone);
  const target = resolveScheduleTiming(expected, unrelatedZone);
  if (stored.kind === "once" && target.kind === "once") {
    return Date.parse(stored.at) === Date.parse(target.at);
  }
  return isDeepStrictEqual(stored, target);
}

const createdTimingSchema = z.object({
  timing: z.record(z.string(), z.unknown()),
});

const createdPromptSchema = z.object({ prompt: z.string() });

const exactEvals = cases.map((testCase) =>
  defineEval({
    description: testCase.description,
    tags: [...agentEvalTags, "schedules"],
    async test(t) {
      const turn = await t.send(testCase.prompt);
      turn.expectOk();
      turn.succeeded();
      // The task is the reminder text, word for word; a model may frame it
      // as an instruction («Send the reminder: …») around it.
      const { prompt, timing, ...expected } = testCase.expected;
      turn.calledTool("schedules-create", {
        input: (input) => {
          const { prompt: _created, timing: createdTiming, ...rest } = input;
          return (
            createdPromptSchema
              .safeParse(input)
              .data?.prompt.includes(prompt) === true &&
            isDeepStrictEqual(rest, expected) &&
            sameStoredTiming(
              scheduleTimingInputSchema.safeParse(createdTiming).data,
              scheduleTimingInputSchema.parse(timing)
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

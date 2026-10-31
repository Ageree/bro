import { describe, expect, it } from "vitest";
import { reportNeeded, workerOutcome } from "@agent/lib/schedules/outcome";
import { scheduledRunOutcomeSchema } from "@shared/schedules/outcome";

const completeResult = `${"Раздел: кириллица 🧭🚀 [Источник](https://example.com/source?q=1&lang=ru)\n".repeat(150)}ФИНАЛЬНЫЙ_SENTINEL_🏁`;

describe("scheduled worker outcomes", () => {
  it("preserves the complete long result through worker and stored schema", () => {
    const outcome = workerOutcome(completeResult);
    expect(outcome).toEqual({
      kind: "result",
      summary: completeResult,
      urgency: "normal",
    });
    expect(scheduledRunOutcomeSchema.parse(outcome)).toEqual(outcome);
    expect(reportNeeded(outcome)).toBe(true);
  });

  it("accepts a complete stored result without a 4000-character ceiling", () => {
    expect(
      scheduledRunOutcomeSchema.parse({
        kind: "result",
        summary: completeResult,
        details: completeResult,
        urgency: "normal",
      })
    ).toMatchObject({ details: completeResult, summary: completeResult });
  });

  it("keeps an ordinary result unchanged", () => {
    expect(workerOutcome("Готово: цена 95 ₽.")).toEqual({
      kind: "result",
      summary: "Готово: цена 95 ₽.",
      urgency: "normal",
    });
  });

  it.each([
    null,
    undefined,
    "",
    "  ",
    "Передавать нечего.",
    "Текст\n<eve-empty-delivery/>",
  ])("keeps the empty-delivery guard for %s", (reply) => {
    expect(workerOutcome(reply).kind).toBe("nothing_to_report");
  });

  it("keeps urgency without truncating the handover", () => {
    expect(workerOutcome(`[срочно]\n${completeResult}`)).toEqual({
      kind: "result",
      summary: completeResult,
      urgency: "time_sensitive",
    });
  });

  it("keeps the blocked and nothing-to-report ceilings", () => {
    expect(
      scheduledRunOutcomeSchema.safeParse({
        kind: "blocked",
        summary: completeResult,
        userActionNeeded: "Ответить.",
      }).success
    ).toBe(false);
    expect(
      scheduledRunOutcomeSchema.safeParse({
        kind: "nothing_to_report",
        reason: completeResult,
      }).success
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { reportNeeded, workerOutcome } from "@agent/lib/schedules/outcome";

const nothing = {
  kind: "nothing_to_report",
  reason: "The scheduled task produced no useful update.",
};

// The proactive worker's final reply on 26.09 (d10 and d11 fixtures, the
// tester's real Google), shortened: the marker put down and taken back
// before the handover.
const takenBack = `I have everything I need. Sorting:

- Thread 1 — fake bank security service from a non-bank domain → **разряд 2, фишинг**.
- Event a5rvk2jm756cd5erpttn0v7f28 — рейс DP 405 завтра 07:05 → **разряд 1**, срочно.

Время сейчас 16:23 → метка \`[срочно]\`.

<eve-empty-delivery/>

Ошибка: метка не должна стоять вместе с передачей. Формирую передачу:

**[срочно] Рейс DP 405 Москва (Внуково) — Сочи, завтра 27.09, вылет 07:05.** Бронь BRB4XK. Выйти примерно в 04:05.

**Похоже на мошенников:** письмо «от Службы безопасности банка» требует подтвердить отмену перевода по ссылке. По ссылке не переходи.`;

describe("workerOutcome", () => {
  it.each([
    "<eve-empty-delivery/>",
    "  <eve-empty-delivery/>\n",
    "&lt;eve-empty-delivery/&gt;",
    "`<eve-empty-delivery/>`",
  ])("records the marker alone as nothing to report: %j", (reply) => {
    expect(workerOutcome(reply)).toEqual(nothing);
  });

  it.each([
    "Передавать нечего.",
    "передавать нечего",
    "Nothing to report.",
    "Разряды: письмо ByteByteGo — рассылка (разряд 5). Передавать нечего.",
    "No new mail; calendar events are routine — nothing needing action.\n\n<eve-empty-delivery/>",
    "Разряды: ByteByteGo — рассылка. Передавать нечего.\n\n<eve-empty-delivery/>",
    "",
    null,
  ])("records a reply that hands nothing over as empty: %j", (reply) => {
    expect(workerOutcome(reply)).toEqual(nothing);
  });

  it("keeps a handover that names the marker mid-reply, without it", () => {
    expect(
      workerOutcome(
        "Рейс SU 1234 завтра в 08:40 из Шереметьево, регистрация открыта (не использую <eve-empty-delivery/>, есть что передать). Выйти примерно в 05:50."
      )
    ).toEqual({
      kind: "result",
      summary:
        "Рейс SU 1234 завтра в 08:40 из Шереметьево, регистрация открыта (не использую , есть что передать). Выйти примерно в 05:50.",
      urgency: "normal",
    });
  });

  it("keeps the handover a worker wrote after taking the marker back", () => {
    const outcome = workerOutcome(takenBack);
    expect(outcome).toMatchObject({ kind: "result" });
    if (outcome.kind !== "result") return;
    expect(outcome.summary).not.toContain("eve-empty-delivery");
    expect(outcome.summary).toContain(
      "**Рейс DP 405 Москва (Внуково) — Сочи, завтра 27.09, вылет 07:05.** Бронь BRB4XK. Выйти примерно в 04:05."
    );
    expect(outcome.summary).toContain("**Похоже на мошенников:**");
    // The handover opens with [срочно] below the worker's reasoning.
    expect(outcome.urgency).toBe("time_sensitive");
  });

  it.each([
    "Посылка СДЭК по заказу 1094857362 придёт 29.09, пункт тот же. Больше передавать нечего.",
    "Рейс SU 1234 завтра в 08:40 из Шереметьево, регистрация уже открыта. Остальное передавать нечего.",
  ])("delivers a real report that ends on «…передавать нечего»", (reply) => {
    expect(workerOutcome(reply)).toEqual({
      kind: "result",
      summary: reply,
      urgency: "normal",
    });
  });

  it("strips the urgent tag and the emphasis left around it", () => {
    expect(
      workerOutcome(
        "**[срочно]**\nРейс SU 1234 в 07:05 из Внуково; выйти примерно в 04:30."
      )
    ).toEqual({
      kind: "result",
      summary: "Рейс SU 1234 в 07:05 из Внуково; выйти примерно в 04:30.",
      urgency: "time_sensitive",
    });
  });

  it("does not take a tag quoted in the reasoning for an urgent handover", () => {
    expect(
      workerOutcome(
        "Посылка СДЭК задерживается до 29.09 (метка `[срочно]` не нужна, это не рейс)."
      )
    ).toMatchObject({ kind: "result", urgency: "normal" });
  });
});

describe("reportNeeded", () => {
  it.each([
    ["Разряды: рассылка. Передавать нечего.\n\n<eve-empty-delivery/>", false],
    ["Передавать нечего.", false],
    [takenBack, true],
    ["Посылка СДЭК придёт 29.09. Больше передавать нечего.", true],
  ])("of a stored result %#", (summary, expected) => {
    expect(reportNeeded({ kind: "result", summary, urgency: "normal" })).toBe(
      expected
    );
  });

  it("keeps a blocked run's report", () => {
    expect(
      reportNeeded({
        kind: "blocked",
        summary: "Google отозвал доступ.",
        userActionNeeded: "Подключить Google заново.",
      })
    ).toBe(true);
  });
});

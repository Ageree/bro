import { describe, expect, it } from "vitest";
import { reportNeeded, workerOutcome } from "@agent/lib/schedules/outcome";

const flightHandover = `<eve-empty-delivery/> is not right here — there is a flight and other items to hand over.

Передача:

Рейс DP 405 Москва (Внуково) — Сочи, завтра 27.09, вылет 07:05, терминал A (Победа, бронь BRB4XK). Онлайн-регистрация уже открыта. Выезжать примерно в 04:05.

Банк: письмо от «Служба безопасности банка» — похоже на мошенников.

Андрей Волков: черновик «Гляну к утру. Какие именно цифры по Q3?». Отправить без «да» не могу.

СДЭК: заказ 1094857362, новая дата 29.09, пункт ул. Профсоюзная, 12.`;

describe("worker outcome", () => {
  it("keeps a handover that mentions the empty marker and then says what happened", () => {
    const outcome = workerOutcome(flightHandover);
    expect(outcome).toEqual({
      kind: "result",
      summary: flightHandover.replace("<eve-empty-delivery/>", "").trim(),
      urgency: "normal",
    });
    expect(reportNeeded(outcome)).toBe(true);
    expect(outcome.kind === "result" && outcome.summary).not.toContain(
      "eve-empty-delivery"
    );
  });

  it("drops a reply that is only the marker, or that ends with it", () => {
    expect(workerOutcome("<eve-empty-delivery/>")).toEqual({
      kind: "nothing_to_report",
      reason: "The scheduled task produced no useful update.",
    });
    expect(
      workerOutcome(
        "No new mail; calendar events are routine — nothing needing action.\n\n<eve-empty-delivery/>"
      )
    ).toEqual({
      kind: "nothing_to_report",
      reason: "The scheduled task produced no useful update.",
    });
    expect(workerOutcome("Разряды: рассылка. Передавать нечего.")).toEqual({
      kind: "nothing_to_report",
      reason: "The scheduled task produced no useful update.",
    });
  });
});

import { describe, expect, it } from "vitest";
import type { BrowserSubmission } from "@shared/browser/submission";
import { formatRub } from "@shared/spending/limit";
import { withApprovalCard } from "./approval-card";

/** The card eve parks for a `browser_task` call that submits this. */
function approval(submission: BrowserSubmission) {
  return {
    action: {
      input: {
        action: "continue",
        allowSubmit: true,
        runId: "run-1",
        submission,
        task: "Оформляй",
      },
      toolName: "browser_task",
    },
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: "Approve tool call: browser_task",
  };
}

describe("the approval card of a basket", () => {
  it("lists every line the person pays for, not only the total", () => {
    const card = withApprovalCard(
      approval({
        amount: "1 298 ₽ с доставкой в ПВЗ",
        chargeRub: 1_298,
        forWhom: "Алиса",
        items: [
          "Корм Whiskas с кроликом 1,9 кг × 2 — 1 298 ₽",
          "Доставка в ПВЗ\n— 0 ₽",
        ],
        kind: "order",
        personalData: [],
        what: "заказ корма",
        where: "Ozon (ozon.ru)",
      }),
      "ru"
    );

    expect(card.prompt).toBe(
      [
        "Подтверждение действия:",
        "Что: заказ корма",
        "Состав:",
        "• Корм Whiskas с кроликом 1,9 кг × 2 — 1 298 ₽",
        // A line break inside a line could pass for a field of its own.
        "• Доставка в ПВЗ — 0 ₽",
        "Где: Ozon (ozon.ru)",
        "От чьего имени: Алиса",
        "Стоимость: 1 298 ₽ с доставкой в ПВЗ",
        "Какие данные уйдут: —",
        `Оплата сохранённой картой, не больше ${formatRub(1_428)}`,
      ].join("\n")
    );
  });

  it("draws no list for a submission that is not a basket", () => {
    const card = withApprovalCard(
      approval({
        forWhom: "Alice",
        kind: "table",
        personalData: ["name"],
        what: "a table for two",
        when: "today, 20:00",
        where: "Pushkin (cafe-pushkin.ru)",
      }),
      "en"
    );

    expect(card.prompt).not.toContain("Items");
    expect(card.prompt).toContain("What: a table for two");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpendLimitSection } from "@app/(authenticated)/workspace/_components/spend-limit-section";
import { formatRub } from "@shared/spending/limit";

describe("workspace spend limit", () => {
  it("explains how to set a limit when there is none", () => {
    const html = renderToStaticMarkup(
      createElement(SpendLimitSection, { entries: [], policy: undefined })
    );

    expect(html).toContain("Траты без спроса");
    expect(html).toContain("Не заданы");
    expect(html).toContain("можешь тратить");
  });

  it("shows each rule with what is spent and left this month", () => {
    const html = renderToStaticMarkup(
      createElement(SpendLimitSection, {
        entries: [
          { amountRub: 1200, category: "еда", feeRub: 0, merchant: "ozon.ru" },
          {
            amountRub: 400,
            category: "дом",
            feeRub: 0,
            merchant: "wildberries.ru",
          },
        ],
        policy: {
          currency: "RUB",
          excludedCategories: ["алкоголь"],
          excludedMerchants: ["wb.ru"],
          rules: [
            { category: null, limitRub: 5000, merchant: null },
            { category: null, limitRub: 2000, merchant: "ozon.ru" },
          ],
          version: 1,
        },
      })
    );

    expect(html).toContain(`до ${formatRub(5000)} в месяц`);
    expect(html).toContain(`до ${formatRub(2000)} в месяц на ozon.ru`);
    // The general rule counts both shops; the ozon.ru rule only its own.
    expect(html).toContain(`потрачено ${formatRub(1600)}`);
    expect(html).toContain(`осталось ${formatRub(3400)}`);
    expect(html).toContain(`потрачено ${formatRub(1200)}`);
    expect(html).toContain(`осталось ${formatRub(800)}`);
    expect(html).toContain("«алкоголь»");
    expect(html).toContain("wb.ru");
    // A category is excluded from the limit, not from standing permissions.
    expect(html).toContain("Не оплачивать по лимиту:");
  });

  it("shows the errands Bro does without a card, with their month", () => {
    const html = renderToStaticMarkup(
      createElement(SpendLimitSection, {
        entries: [],
        policy: {
          actions: [{ kind: "taxi", maxRub: 1500, merchant: null }],
          currency: "RUB",
          excludedCategories: [],
          excludedMerchants: [],
          rules: [],
          version: 1,
        },
        standingEntries: [
          {
            amountRub: 700,
            category: "taxi",
            feeRub: 0,
            merchant: "taxi.yandex.ru",
          },
        ],
      })
    );

    expect(html).toContain("Включены");
    expect(html).toContain("Без подтверждения");
    expect(html).toContain(
      `заказы такси без спроса, на любых сайтах, до ${formatRub(1500)} за раз и до ${formatRub(4500)} в месяц`
    );
    expect(html).toContain(`потрачено ${formatRub(700)}`);
    expect(html).toContain(`осталось ${formatRub(3800)}`);
    // Paid permissions are not «only free» just because no limit is set.
    expect(html).not.toContain("только бесплатное. Напиши");
    expect(html).not.toContain("Без спроса Bro оформляет только бесплатное");
  });

  it("marks a permission an excluded site takes away, and the sites it skips", () => {
    const html = renderToStaticMarkup(
      createElement(SpendLimitSection, {
        entries: [],
        policy: {
          actions: [
            { kind: "order", maxRub: 3000, merchant: "lavka.yandex.ru" },
            { kind: "table", maxRub: null, merchant: null },
          ],
          currency: "RUB",
          excludedCategories: [],
          excludedMerchants: ["lavka.yandex.ru"],
          rules: [],
          version: 1,
        },
      })
    );

    expect(html).toContain("не действует");
    expect(html).toContain("Кроме: lavka.yandex.ru");
  });
});

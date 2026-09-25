import { describe, expect, it } from "vitest";
import { withGroupedRoubles } from "@agent/lib/delivery/amounts";

/** Written with a plain space for readability; the result has U+00A0. */
function nbsp(text: string) {
  return text.replaceAll("_", " ");
}

describe("withGroupedRoubles", () => {
  it.each([
    ["мужская стрижка 2000 ₽", "мужская стрижка 2_000 ₽"],
    ["от 15225 ₽, это выше лимита", "от 15_225 ₽, это выше лимита"],
    ["итого 15225₽", "итого 15_225₽"],
    ["1234567 руб.", "1_234_567 руб."],
    ["до 3500 рублей", "до 3_500 рублей"],
    ["за 2500 рубля", "за 2_500 рубля"],
    ["стрижка 1690–2290 ₽", "стрижка 1_690–2_290 ₽"],
    ["от 15000 до 20000 ₽", "от 15_000 до 20_000 ₽"],
    ["1085,95 ₽ с доставкой", "1_085,95 ₽ с доставкой"],
    ["**2000 ₽**", "**2_000 ₽**"],
    ["(1900 ₽)", "(1_900 ₽)"],
    ["в 2026 году 1500 ₽", "в 2026 году 1_500 ₽"],
    ["в 19:00, 2000 ₽ на человека", "в 19:00, 2_000 ₽ на человека"],
    ["900–1500 ₽", "900–1_500 ₽"],
  ])("groups «%s»", (text, expected) => {
    expect(withGroupedRoubles(text)).toBe(nbsp(expected));
  });

  it.each([
    ["an already grouped sum", "Текущая цена: 1 422 ₽"],
    ["a sum grouped by no-break spaces", nbsp("15_225 ₽")],
    ["a sum under a thousand", "от 393 ₽"],
    ["a year", "2026 год, а в 2027 посмотрим"],
    ["a code", "код 739204"],
    ["a phone", "+7 999 123-45-67, звони с 9 до 18"],
    ["an order number", "заказ № 12345 оформлен"],
    ["a time", "подача в 17:40–17:50"],
    ["a link", "https://pay.example/invoice?sum=15000₽&id=48213"],
    ["a Markdown link target", "[оплата](https://pay.example/15000₽)"],
    ["a code span", "`15000 ₽` в поле суммы"],
    ["a fenced block", "```\nsum = 15000 ₽\n```"],
    ["a word that is not the rouble", "2000 рубежей"],
    ["a number glued to a word", "ID48213 ₽"],
  ])("leaves %s alone", (_case, text) => {
    expect(withGroupedRoubles(text)).toBe(text);
  });

  it("groups around what it leaves alone", () => {
    expect(
      withGroupedRoubles(
        "[DM](https://yandex.com/maps/org/dm/224537773042/) — стрижка 1900 ₽, код `4821 ₽`, заказ 48213 на 12000 ₽"
      )
    ).toBe(
      nbsp(
        "[DM](https://yandex.com/maps/org/dm/224537773042/) — стрижка 1_900 ₽, код `4821 ₽`, заказ 48213 на 12_000 ₽"
      )
    );
  });
});

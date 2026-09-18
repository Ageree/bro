import { describe, expect, it } from "vitest";
import {
  browserOutcomeSummary,
  merchantFromText,
  parseBrowserOrder,
  parseBrowserOutcome,
} from "@agent/lib/browser-use/outcome";

describe("browser run outcome parsing", () => {
  it("reads the labelled block whatever language its values are in", () => {
    const outcome = parseBrowserOutcome(
      [
        "Заказ оформлен.",
        "RESULT: такси вызвано к подъезду",
        "ORDER: 4417",
        "TOTAL: 620 ₽",
        "NEEDS: none",
        "DETAILS: none",
      ].join("\n")
    );

    expect(outcome).toEqual({
      details: undefined,
      labelled: true,
      needs: "none",
      order: "4417",
      result: "такси вызвано к подъезду",
      total: "620 ₽",
    });
  });

  it("tolerates bullets and bold around the labels", () => {
    const outcome = parseBrowserOutcome(
      ["- **RESULT:** stopped at the code step", "* **NEEDS:** sms_code"].join(
        "\n"
      )
    );

    expect(outcome.result).toBe("stopped at the code step");
    expect(outcome.needs).toBe("sms_code");
    expect(outcome.labelled).toBe(true);
  });

  it("falls back to none for an unlabelled or unknown need", () => {
    expect(parseBrowserOutcome("It worked.").needs).toBe("none");
    expect(parseBrowserOutcome("It worked.").labelled).toBe(false);
    expect(parseBrowserOutcome("NEEDS: fingerprint").needs).toBe("none");
    expect(parseBrowserOutcome(null).needs).toBe("none");
    expect(parseBrowserOutcome("NEEDS: 3ds").needs).toBe("3ds");
  });

  it("summarizes only the facts the run reported", () => {
    const outcome = parseBrowserOutcome(
      [
        "RESULT: booked",
        "ORDER: none",
        "NEEDS: 3ds",
        "DETAILS: confirm in the bank app",
      ].join("\n")
    );

    expect(browserOutcomeSummary(outcome, "fallback")).toBe(
      ["Result: booked", "Needs: 3ds", "Details: confirm in the bank app"].join(
        "\n"
      )
    );
    expect(browserOutcomeSummary(parseBrowserOutcome(""), "fallback")).toBe(
      "fallback"
    );
  });
});

function purchase(lines: readonly string[]) {
  return lines.join("\n");
}

describe("order parsing", () => {
  it("names the merchant from the site the run was pointed at", () => {
    expect(merchantFromText("https://www.wildberries.ru/catalog", "купи")).toBe(
      "wb"
    );
    expect(merchantFromText("https://www.ozon.ru/product/1")).toBe("ozon");
    // The wording is only consulted when the site does not decide it.
    expect(merchantFromText(null, "купи кроссовки на вб")).toBe("wb");
    expect(merchantFromText(null, "закажи на озоне")).toBe("ozon");
    expect(merchantFromText(null, "закажи такси")).toBe("other");
    // A word that merely contains "вб" is not Wildberries.
    expect(merchantFromText(null, "посмотри вбитые данные")).toBe("other");
  });

  it("records a run that reported an order number and an amount", () => {
    const result = purchase([
      "RESULT: Кроссовки Nike куплены",
      "ORDER: WB-4K7X2",
      "TOTAL: 5 499,00 ₽",
      "NEEDS: none",
      "DETAILS: ПВЗ: Ленина 1, ячейка 12",
    ]);

    expect(
      parseBrowserOrder(parseBrowserOutcome(result), {
        result,
        site: "https://www.wildberries.ru",
        task: "купи кроссовки",
      })
    ).toEqual({
      merchant: "wb",
      merchantOrderId: "WB-4K7X2",
      pickup: "Ленина 1, ячейка 12",
      priceRub: 5499,
      status: "placed",
      title: "Кроссовки Nike куплены",
    });
  });

  it("records nothing for a run that still needs something", () => {
    const result = purchase([
      "RESULT: дошёл до оплаты",
      "ORDER: 4417",
      "TOTAL: 620 ₽",
      "NEEDS: 3ds",
    ]);

    expect(
      parseBrowserOrder(parseBrowserOutcome(result), {
        result,
        site: null,
        task: "купи",
      })
    ).toBeNull();
  });

  it("records nothing without both an order number and an amount", () => {
    const withoutTotal = purchase([
      "RESULT: оформлено",
      "ORDER: 4417",
      "TOTAL: none",
      "NEEDS: none",
    ]);
    const withoutOrder = purchase([
      "RESULT: оформлено",
      "ORDER: none",
      "TOTAL: 620 ₽",
      "NEEDS: none",
    ]);
    const run = { result: withoutTotal, site: null, task: "купи" };

    expect(
      parseBrowserOrder(parseBrowserOutcome(withoutTotal), run)
    ).toBeNull();
    expect(
      parseBrowserOrder(parseBrowserOutcome(withoutOrder), {
        ...run,
        result: withoutOrder,
      })
    ).toBeNull();
  });

  it("refuses a card number printed where the order number belongs", () => {
    // Luhn-valid, and exactly the length of a WB order number.
    const result = purchase([
      "RESULT: оплачено",
      "ORDER: 4242424242424242",
      "TOTAL: 620 ₽",
      "NEEDS: none",
    ]);

    expect(
      parseBrowserOrder(parseBrowserOutcome(result), {
        result,
        site: null,
        task: "купи",
      })
    ).toBeNull();
  });

  it("keeps a cancelled purchase as cancelled", () => {
    const result = purchase([
      "RESULT: заказ отменён по твоей просьбе",
      "ORDER: 46000123456781",
      "TOTAL: 620 ₽",
      "NEEDS: none",
    ]);

    expect(
      parseBrowserOrder(parseBrowserOutcome(result), {
        result,
        site: "https://www.ozon.ru",
        task: "отмени заказ",
      })
    ).toMatchObject({ merchant: "ozon", status: "cancelled" });
  });
});

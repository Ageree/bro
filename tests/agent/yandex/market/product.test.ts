import { describe, expect, it } from "vitest";
import { marketProductOperation } from "@agent/lib/yandex/market/product";
import { fixturePage, okData, runOnPage, signedInState } from "./run-page";

const url =
  "/card/testovyy-kabel-nimbus/900000000010?do-waremd5=AAAAAAAAAAAAAAAAAAAAA9";

const card = () => ({ body: fixturePage("product.json") });

describe("market.product", () => {
  it("reads the card: price, card price, shop, delivery and the main specs", async () => {
    const { data } = await okData(marketProductOperation, { url }, (request) =>
      request.path.startsWith("/card/") ? card() : undefined
    );
    expect(data.delivery?.text).toContain("24 – 28 окт");
    expect(data).toEqual({
      available: true,
      brand: "Nimbus",
      delivery: { price: 219, text: data.delivery?.text },
      flags: ["isDsbs", "isCrossborder"],
      maxQty: 500,
      minQty: 1,
      offerId: "AAAAAAAAAAAAAAAAAAAAA9",
      oldPrice: 161,
      price: 81,
      priceCard: 67,
      rating: { count: 12, value: 4.8 },
      shop: { name: "Магазин Тест", rating: "4.4 330.1K оценок" },
      sku: "900000000010",
      specs: [
        { name: "Артикул Маркета", value: "900000000010" },
        { name: "Длина кабеля", value: "1 м" },
        { name: "Разъём", value: "USB Type-C" },
      ],
      title: "Тестовый кабель Nimbus USB-C, 1 м",
      url: "https://market.yandex.ru/card/testovyy-kabel-nimbus/900000000010?do-waremd5=AAAAAAAAAAAAAAAAAAAAA9",
    });
  });

  it("refuses an address that is not a card before any request", async () => {
    await expect(
      runOnPage(
        marketProductOperation,
        { url: "https://evil.example/card/x/1" },
        () => card()
      )
    ).rejects.toThrow("bad_argument");
  });

  it("fails as not found when the page has no product", async () => {
    await expect(
      runOnPage(marketProductOperation, { url }, () => ({
        body: `<html><body>${signedInState}Товар не найден</body></html>`,
      }))
    ).rejects.toThrow("not_found");
  });

  it("answers signed_out when the card redirects to the sign-in", async () => {
    const { answer } = await runOnPage(marketProductOperation, { url }, () => ({
      body: "",
      url: "https://passport.yandex.ru/auth?retpath=x",
    }));
    expect(answer).toEqual({ status: "signed_out" });
  });
});

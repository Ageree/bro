import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  marketCartAddOperation,
  marketCartOperation,
  marketCartRemoveOperation,
} from "@agent/lib/yandex/market/cart";
import { fixture, fixturePage, okData, runOnPage } from "./run-page";

const cartPage = () => ({ body: fixturePage("cart.json") });
const cartAdd = fixture("cart_add.json");
const sent = z.object({
  params: z.object({ items: z.array(z.record(z.string(), z.json())) }),
});
const card = () => ({ body: fixturePage("product.json") });
const cardUrl =
  "/card/testovyy-kabel-nimbus/900000000010?do-waremd5=AAAAAAAAAAAAAAAAAAAAA9";

describe("market.cart", () => {
  it("reads the positions and the totals of the cart page", async () => {
    const { data } = await okData(marketCartOperation, {}, (request) =>
      request.path === "/my/cart" ? cartPage() : undefined
    );
    expect(data).toEqual({
      count: 1,
      items: [
        {
          available: true,
          count: 1,
          delivery: "1 – 6 ноя, ПВЗПо клику",
          maxCount: 69,
          offerId: "AAAAAAAAAAAAAAAAAAAAA8",
          oldPrice: 2790,
          price: 1284,
          priceCard: 1155,
          title: "Тестовый чайник Nimbus",
        },
      ],
      total: { line: "1 товар", withCard: 1155, withoutCard: 1284 },
    });
  });

  it("answers signed_out on the sign-in redirect", async () => {
    const { answer } = await runOnPage(marketCartOperation, {}, () => ({
      body: "",
      url: "https://passport.yandex.ru/auth",
    }));
    expect(answer).toEqual({ status: "signed_out" });
  });
});

describe("market.cart_add", () => {
  it("adds the card's offer with its show token and reads the new cart", async () => {
    const { data, requests } = await okData(
      marketCartAddOperation,
      { url: cardUrl },
      (request) => {
        if (request.method === "POST")
          return { body: JSON.stringify(cartAdd.response_200) };
        return card();
      }
    );
    expect(data).toEqual({
      cartItemId: "1000000000002",
      cartPositions: 2,
      count: 1,
      offerId: "AAAAAAAAAAAAAAAAAAAAA9",
      title: "Тестовый кабель Nimbus USB-C, 1 м",
    });
    const post = requests.find((request) => request.method === "POST");
    expect(sent.parse(JSON.parse(post?.body ?? "{}")).params.items).toEqual([
      {
        feeShow:
          "FAKEFEESHOWxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        offerId: "AAAAAAAAAAAAAAAAAAAAA9",
      },
    ]);
  });

  it("fails when the cart does not answer with its model", async () => {
    await expect(
      runOnPage(marketCartAddOperation, { url: cardUrl }, (request) =>
        request.method === "POST"
          ? {
              body: JSON.stringify(cartAdd.response_500_without_feeShow),
              status: 500,
            }
          : card()
      )
    ).rejects.toThrow("add_failed");
  });

  it("refuses a change of the cart the person did not ask for", () => {
    expect(
      marketCartAddOperation.input.safeParse({
        operation: "market.cart_add",
        url: cardUrl,
      }).success
    ).toBe(false);
    expect(
      marketCartAddOperation.input.safeParse({
        operation: "market.cart_add",
        personAskedToChangeCart: true,
        url: cardUrl,
      }).success
    ).toBe(true);
  });
});

describe("market.cart_remove", () => {
  it("sets the position to zero and reads what is left", async () => {
    const { data, requests } = await okData(
      marketCartRemoveOperation,
      { offerId: "AAAAAAAAAAAAAAAAAAAAA8" },
      (request) => {
        if (request.method === "POST") {
          return {
            body: JSON.stringify({
              result: {
                collections: {
                  cartModel: { carts: { market: { count: 0 } }, items: {} },
                },
              },
            }),
          };
        }
        return cartPage();
      }
    );
    expect(data).toEqual({
      count: 0,
      cartPositions: 0,
      offerId: "AAAAAAAAAAAAAAAAAAAAA8",
    });
    const post = requests.find((request) => request.method === "POST");
    expect(sent.parse(JSON.parse(post?.body ?? "{}")).params.items).toEqual([
      {
        cartItemId: "1000000000001",
        count: 0,
        offerId: "AAAAAAAAAAAAAAAAAAAAA8",
      },
    ]);
  });

  it("answers an offer that is not in the cart without a change", async () => {
    const { data, requests } = await okData(
      marketCartRemoveOperation,
      { offerId: "NOSUCHOFFER0000000000" },
      cartPage
    );
    expect(data).toEqual({
      count: 0,
      cartPositions: null,
      offerId: "NOSUCHOFFER0000000000",
    });
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { marketSearchOperation } from "@agent/lib/yandex/market/search";
import { fixtureText, okData, runOnPage } from "./run-page";

const resolver = () => ({ body: fixtureText("search.json") });

describe("market.search", () => {
  it("reads the offers of the resolver page, once each", async () => {
    const { data, requests } = await okData(
      marketSearchOperation,
      { limit: 10, query: "наушники" },
      (request) =>
        request.path.startsWith("/api/resolve/") ? resolver() : undefined
    );
    expect(data.total).toBe(3416);
    expect(data.items.map((item) => item.offerId)).toEqual([
      "AAAAAAAAAAAAAAAAAAAAA1",
      "AAAAAAAAAAAAAAAAAAAAA2",
      "AAAAAAAAAAAAAAAAAAAAA3",
    ]);
    expect(data.items[0]).toMatchObject({
      flags: ["sponsored", "Осталось 3 шт"],
      oldPrice: 2499,
      price: 660,
      priceCard: 502,
      rating: { bought: 232, count: 60, value: 4.7 },
      shop: "Магазин Тест",
    });
    // The offer with no shop and no rating answers null, not a missing key.
    expect(data.items[2]).toMatchObject({
      rating: null,
      shop: "Магазин Тест 2",
    });
    expect(data.items[1]?.shop).toBeNull();
    expect(data.count).toBe(3);
    expect(data.items.every((item) => item.url.startsWith("/card/"))).toBe(
      true
    );
    // The fixture's second page repeats the first: the call stops there.
    expect(requests).toHaveLength(2);
  });

  it("sends the sort and the price bounds the person gave", async () => {
    const { requests } = await okData(
      marketSearchOperation,
      {
        limit: 5,
        priceFrom: 300,
        priceTo: 600,
        query: "кабель",
        sort: "price_asc",
      },
      (request) =>
        request.path.startsWith("/api/resolve/") ? resolver() : undefined
    );
    const sent = z
      .object({
        params: z.array(
          z.object({
            filters: z.record(z.string(), z.string()),
            how: z.string(),
            text: z.string(),
          })
        ),
      })
      .parse(JSON.parse(requests[0]?.body ?? "{}"));
    expect(sent.params[0]).toMatchObject({
      filters: { priceto: "600", pricefrom: "300" },
      how: "aprice",
      text: "кабель",
    });
  });

  it("answers signed_out when the resolver says 401", async () => {
    const { answer } = await runOnPage(
      marketSearchOperation,
      { query: "наушники" },
      () => ({ body: "", status: 401 })
    );
    expect(answer).toEqual({ status: "signed_out" });
  });

  it("answers captcha when the resolver lands on the check", async () => {
    const { answer } = await runOnPage(
      marketSearchOperation,
      { query: "наушники" },
      () => ({ body: "", url: "https://market.yandex.ru/showcaptcha?x=1" })
    );
    expect(answer).toEqual({ status: "captcha" });
  });

  it("fails without the page's text when the answer changed shape", async () => {
    await expect(
      runOnPage(marketSearchOperation, { query: "наушники" }, () => ({
        body: JSON.stringify({ results: [{ data: {} }] }),
      }))
    ).rejects.toThrow("bad_response");
  });
});

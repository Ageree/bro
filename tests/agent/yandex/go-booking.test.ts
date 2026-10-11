import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  goBookOperation,
  goCancelOperation,
  goRideOperation,
} from "@agent/lib/yandex/go/booking";
import type { JsonValue } from "@agent/lib/yandex/operations";
import { type FakeResponse, dataOf, fixture, runInPage } from "./page";

const userId = "0123456789abcdef0123456789abcdef";

const activeHistory = {
  orders: [
    {
      service: "taxi",
      data: {
        is_active: true,
        order_id: "active-order",
        taxi_status: "driving",
        route: { source: "Мичуринский проспект, 56", destination: "Раменки" },
        payment: { cost: 415 },
        vehicle: { color: "белый", model: "Kia Rio", car_number: "А001АА77" },
      },
    },
  ],
};

const finalsuggest = (text: string): FakeResponse => ({
  body: {
    results: [
      {
        type: "address",
        text: `Москва, ${text}`,
        title: { text },
        position: [37.5, 55.7],
        uri: "ymapsbm1://geo?test",
      },
    ],
  },
});

/** The Go page: fixtures by path, with answers a test changes by path. */
async function goPage(answers: Record<string, FakeResponse | FakeResponse[]>) {
  const base: Record<string, FakeResponse | FakeResponse[]> = {
    "/csrf_token": { body: await fixture("go/csrf-token.json") },
    "/4.0/orderhistory/v2/list": {
      body: await fixture("go/orderhistory.json"),
    },
    "/4.0/persuggest/v1/suggest": { body: await fixture("go/suggest.json") },
    "/4.0/persuggest/v1/finalsuggest": finalsuggest("Мичуринский проспект, 56"),
    "/3.0/routestats": { body: await fixture("go/routestats.json") },
    "/external/3.0/orderdraft": { body: { orderid: "new-order" } },
    "/external/3.0/ordercommit": { body: { status: "search" } },
    ...answers,
  };
  const requests: { body: JsonValue; path: string }[] = [];
  return {
    requests,
    sent: (path: string) => requests.filter((r) => r.path === path),
    page: {
      indexedDb: { userId },
      origin: "https://taxi.yandex.ru/",
      respond(url: URL, init: { body?: string | null }) {
        requests.push({
          body: z.json().parse(JSON.parse(init.body ?? "null")),
          path: url.pathname,
        });
        const answer = base[url.pathname];
        if (Array.isArray(answer))
          return answer.shift() ?? { body: {}, status: 500 };
        return answer ?? { body: {}, status: 404 };
      },
    },
  };
}

const book = (args: Record<string, JsonValue> = {}) =>
  goBookOperation.args.parse({
    from: "Мичуринский проспект, 56",
    payment: "cash",
    to: "метро Раменки",
    ...args,
  });

describe("go.book", () => {
  it("books a cash econom ride in one go: places, quote, draft, commit", async () => {
    const { page, requests, sent } = await goPage({});
    const data = dataOf(await runInPage(goBookOperation.run, book(), page));
    expect(goBookOperation.result.parse(data)).toEqual({
      kind: "booked",
      orderId: "new-order",
      status: "search",
      price: 780,
      from: "Мичуринский проспект, 56",
      to: "Мичуринский проспект, 56",
      payment: "наличные",
    });
    expect(requests.map((r) => r.path).slice(-3)).toEqual([
      "/3.0/routestats",
      "/external/3.0/orderdraft",
      "/external/3.0/ordercommit",
    ]);
    expect(sent("/external/3.0/orderdraft")[0]?.body).toMatchObject({
      id: userId,
      class: ["econom"],
      offer: "00000000000000000000000000000000",
      payment: { type: "cash" },
      route: [{ type: "address", geopoint: [37.5, 55.7] }, { type: "address" }],
    });
    expect(sent("/external/3.0/ordercommit")[0]?.body).toEqual({
      id: userId,
      orderid: "new-order",
    });
  });

  it("answers the ride that is on instead of booking a second one", async () => {
    const { page, sent } = await goPage({
      "/4.0/orderhistory/v2/list": { body: activeHistory },
    });
    const data = dataOf(await runInPage(goBookOperation.run, book(), page));
    expect(data).toMatchObject({
      kind: "already_active",
      ride: { orderId: "active-order", car: "белый Kia Rio А001АА77" },
    });
    expect(sent("/external/3.0/orderdraft")).toHaveLength(0);
  });

  it("does not book above the person's limit", async () => {
    const { page, sent } = await goPage({});
    const data = dataOf(
      await runInPage(goBookOperation.run, book({ maxPriceRub: 500 }), page)
    );
    expect(data).toMatchObject({ kind: "over_limit", price: 780 });
    expect(sent("/external/3.0/orderdraft")).toHaveLength(0);
  });

  it("treats a refused draft as nothing booked and never commits it", async () => {
    const { page, sent } = await goPage({
      "/external/3.0/orderdraft": { body: {}, status: 409 },
    });
    const data = dataOf(await runInPage(goBookOperation.run, book(), page));
    expect(data).toEqual({ kind: "failed", reason: "draft_http_409" });
    expect(sent("/external/3.0/ordercommit")).toHaveLength(0);
  });

  it("sends the commit again on 202, as the site does, and the draft once", async () => {
    const { page, sent } = await goPage({
      "/external/3.0/ordercommit": [
        { body: {}, status: 202 },
        { body: { status: "search" } },
      ],
    });
    const data = dataOf(await runInPage(goBookOperation.run, book(), page));
    expect(data).toMatchObject({ kind: "booked", orderId: "new-order" });
    expect(sent("/external/3.0/orderdraft")).toHaveLength(1);
    expect(sent("/external/3.0/ordercommit")).toHaveLength(2);
  });

  it("keeps a commit without an answer unknown, with its order id", async () => {
    const { page } = await goPage({
      "/external/3.0/ordercommit": { body: {}, status: 500 },
    });
    expect(dataOf(await runInPage(goBookOperation.run, book(), page))).toEqual({
      kind: "unknown",
      orderId: "new-order",
    });
  });
});

describe("go.ride and go.cancel", () => {
  it("reads the ride that is on", async () => {
    const { page } = await goPage({
      "/4.0/orderhistory/v2/list": { body: activeHistory },
    });
    expect(dataOf(await runInPage(goRideOperation.run, {}, page))).toEqual({
      ride: {
        car: "белый Kia Rio А001АА77",
        from: "Мичуринский проспект, 56",
        orderId: "active-order",
        price: 415,
        status: "driving",
        to: "Раменки",
      },
    });
  });

  it("cancels the ride that is on as the cancel button does", async () => {
    const { page, sent } = await goPage({
      "/4.0/orderhistory/v2/list": { body: activeHistory },
      "/3.0/taxiontheway": [
        { body: { status: "driving", cancel_disabled: false } },
        { body: { status: "cancelled" } },
      ],
    });
    expect(dataOf(await runInPage(goCancelOperation.run, {}, page))).toEqual({
      kind: "cancelled",
      orderId: "active-order",
    });
    expect(sent("/3.0/taxiontheway")[1]?.body).toMatchObject({
      orderid: "active-order",
      break: "user",
    });
  });

  it("leaves a ride Yandex no longer lets cancel, and says there is none to cancel", async () => {
    const locked = await goPage({
      "/4.0/orderhistory/v2/list": { body: activeHistory },
      "/3.0/taxiontheway": {
        body: { status: "transporting", cancel_disabled: true },
      },
    });
    expect(
      dataOf(await runInPage(goCancelOperation.run, {}, locked.page))
    ).toEqual({ kind: "cannot_cancel", status: "transporting" });
    expect(locked.sent("/3.0/taxiontheway")).toHaveLength(1);
    const none = await goPage({});
    expect(
      dataOf(await runInPage(goCancelOperation.run, {}, none.page))
    ).toEqual({ kind: "no_ride" });
  });
});

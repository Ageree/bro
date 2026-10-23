import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  goBookOperation,
  goCancelOperation,
  goRideOperation,
} from "@agent/lib/yandex/go/booking";
import { goCardVerifyOperation } from "@agent/lib/yandex/go/card";
import type { JsonValue } from "@agent/lib/yandex/operations";
import { type FakeResponse, dataOf, fixture, overlap, runInPage } from "./page";

const userId = "0123456789abcdef0123456789abcdef";

const activeLaunch = {
  orders: [{ orderid: "active-order", status: "driving" }],
};

const activeOrder = {
  status: "driving",
  cancel_disabled: false,
  final_cost: 415,
  request: {
    route: [
      { short_text: "Мичуринский проспект, 56" },
      { short_text: "Раменки" },
    ],
  },
  driver: { color: "белый", car_model: "Kia Rio", plates: "А001АА77" },
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
  const base = new Map<string, FakeResponse | FakeResponse[]>([
    ["/csrf_token", { body: await fixture("go/csrf-token.json") }],
    ["/3.0/launch", { body: { orders: [] } }],
    ["/4.0/persuggest/v1/suggest", { body: await fixture("go/suggest.json") }],
    [
      "/4.0/persuggest/v1/finalsuggest",
      finalsuggest("Мичуринский проспект, 56"),
    ],
    ["/3.0/routestats", { body: await fixture("go/routestats.json") }],
    ["/external/3.0/orderdraft", { body: { orderid: "new-order" } }],
    ["/external/3.0/ordercommit", { body: { status: "search" } }],
    // The page config that carries Go's Trust token.
    ["/", { body: { trustToken: "taxifee_test" } }],
    ...Object.entries(answers),
  ]);
  const requests: { body: JsonValue; path: string; query: string }[] = [];
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
          query: url.search,
        });
        const answer = base.get(url.pathname);
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
    expect(sent("/external/3.0/orderdraft")[0]?.body).not.toHaveProperty(
      "extra_contact_phone"
    );
  });

  it("reads the ride that is on and both places together, and writes only after all of them", async () => {
    const { page, requests } = await goPage({});
    const together = overlap(
      (url) =>
        url.pathname === "/3.0/launch" ||
        url.pathname === "/4.0/persuggest/v1/suggest",
      3
    );
    const timeouts: number[] = [];
    const data = dataOf(
      await runInPage(goBookOperation.run, book(), {
        ...page,
        hold: together.hold,
        timeouts,
      })
    );
    expect(data).toMatchObject({ kind: "booked" });
    expect(together.overlapped()).toBe(true);
    expect(timeouts).toEqual([]);
    const paths = requests.map((r) => r.path);
    const draft = paths.indexOf("/external/3.0/orderdraft");
    expect(paths.indexOf("/3.0/launch")).toBeLessThan(draft);
    expect(paths.lastIndexOf("/4.0/persuggest/v1/finalsuggest")).toBeLessThan(
      paths.indexOf("/3.0/routestats")
    );
    expect(paths.indexOf("/3.0/routestats")).toBeLessThan(draft);
  });

  it("answers the ride that is on first, even when the places were not found", async () => {
    const { page, sent } = await goPage({
      "/3.0/launch": { body: activeLaunch },
      "/3.0/taxiontheway": { body: activeOrder },
      "/4.0/persuggest/v1/suggest": { body: { results: [] } },
    });
    const data = dataOf(await runInPage(goBookOperation.run, book(), page));
    expect(data).toMatchObject({ kind: "already_active" });
    expect(sent("/3.0/routestats")).toHaveLength(0);
    expect(sent("/external/3.0/orderdraft")).toHaveLength(0);
  });

  it("answers the ride that is on instead of booking a second one", async () => {
    const { page, sent } = await goPage({
      "/3.0/launch": { body: activeLaunch },
      "/3.0/taxiontheway": { body: activeOrder },
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

  it("books for another person as the site does: their number and name in the draft", async () => {
    const { page, sent } = await goPage({});
    const data = dataOf(
      await runInPage(
        goBookOperation.run,
        book({ passengerName: "Маша", passengerPhone: "+7 916 123-45-67" }),
        page
      )
    );
    expect(data).toMatchObject({
      kind: "booked",
      passenger: { name: "Маша", phone: "+79161234567" },
    });
    expect(sent("/external/3.0/orderdraft")[0]?.body).toMatchObject({
      extra_contact_phone: "+79161234567",
      extra_passenger_name: "Маша",
    });
  });

  it("books nothing for another person where the tariff refuses it", async () => {
    const { page, sent } = await goPage({
      "/3.0/routestats": {
        body: {
          offer: "offer-1",
          service_levels: [
            {
              class: "econom",
              is_fixed_price: true,
              max_price_as_decimal: "780.00",
              order_for_other_prohibited: true,
            },
          ],
        },
      },
    });
    const data = dataOf(
      await runInPage(
        goBookOperation.run,
        book({ passengerPhone: "+79161234567" }),
        page
      )
    );
    expect(data).toEqual({
      kind: "failed",
      reason: "order_for_other_unavailable",
    });
    expect(sent("/external/3.0/orderdraft")).toHaveLength(0);
  });
});

const visa = { id: "card-x1a", number: "****4310", system: "VISA" };
const mir = {
  currency: "RUB",
  id: "card-x2b",
  number: "****6443",
  profile: { name: "yandex_default" },
  title: "Мир •••• 6443",
  usable: false,
  verify_strategy: "card_antifraud",
};

describe("go.book with a card Go holds back", () => {
  it("books nothing and names the card to verify", async () => {
    const { page, sent } = await goPage({
      "/3.0/paymentmethods": {
        body: { card: { available_cards: [mir], unverified_cards: [mir] } },
      },
    });
    const data = dataOf(
      await runInPage(goBookOperation.run, book({ payment: "card" }), page)
    );
    expect(goBookOperation.result.parse(data)).toEqual({
      kind: "failed",
      reason: "no_verified_card",
      unverifiedCardId: "card-x2b",
    });
    expect(sent("/3.0/routestats")).toHaveLength(0);
  });

  it("still books with a verified card beside an unverified one", async () => {
    const { page, sent } = await goPage({
      "/3.0/paymentmethods": {
        body: {
          card: { available_cards: [visa, mir], unverified_cards: [mir] },
        },
      },
    });
    const data = dataOf(
      await runInPage(goBookOperation.run, book({ payment: "card" }), page)
    );
    expect(data).toMatchObject({ kind: "booked", payment: "VISA ****4310" });
    expect(sent("/external/3.0/orderdraft")[0]?.body).toMatchObject({
      payment: { type: "card", payment_method_id: "card-x1a" },
    });
  });
});

describe("go.book with the card the person named", () => {
  const methods: FakeResponse = {
    body: { card: { available_cards: [visa], unverified_cards: [mir] } },
  };
  const byCard = (cardLast4: string) => book({ cardLast4, payment: "card" });

  it("books with that card, not the first one", async () => {
    const second = { ...visa, id: "card-x3c", number: "****1111" };
    const { page, sent } = await goPage({
      "/3.0/paymentmethods": {
        body: { card: { available_cards: [visa, second] } },
      },
    });
    const data = dataOf(
      await runInPage(goBookOperation.run, byCard("1111"), page)
    );
    expect(data).toMatchObject({ kind: "booked", payment: "VISA ****1111" });
    expect(sent("/external/3.0/orderdraft")[0]?.body).toMatchObject({
      payment: { payment_method_id: "card-x3c" },
    });
  });

  it("names that card to verify when Go holds it back, though another is verified", async () => {
    const { page, sent } = await goPage({ "/3.0/paymentmethods": methods });
    expect(
      dataOf(await runInPage(goBookOperation.run, byCard("6443"), page))
    ).toEqual({
      kind: "failed",
      reason: "no_verified_card",
      unverifiedCardId: "card-x2b",
    });
    expect(sent("/external/3.0/orderdraft")).toHaveLength(0);
  });

  it("books nothing with a card that is not linked", async () => {
    const { page } = await goPage({ "/3.0/paymentmethods": methods });
    expect(
      dataOf(await runInPage(goBookOperation.run, byCard("0000"), page))
    ).toEqual({ kind: "failed", reason: "card_not_found" });
  });
});

describe("go.card_verify", () => {
  const verify = goCardVerifyOperation.args.parse({ cardId: "card-x2b" });
  const trustForm =
    "https://trust.yandex.ru/web/binding?lang=ru&layout=default&theme=light&verification_intent_id=verification_intent_1#sign:ed25519:v1:AA==";

  it("asks Trust for a verification intent of the card, as Trust's web SDK does", async () => {
    const { page, sent } = await goPage({
      "/3.0/paymentmethods": {
        body: {
          card: { available_cards: [visa, mir], unverified_cards: [mir] },
        },
      },
      "/web/create_verification_intent": {
        body: { form_url: trustForm, id: "verification_intent_1" },
        status: 201,
      },
    });
    const data = dataOf(
      await runInPage(goCardVerifyOperation.run, verify, page)
    );
    expect(goCardVerifyOperation.result.parse(data)).toEqual({
      kind: "link",
      card: "Мир •••• 6443",
      last4: "6443",
      url: trustForm,
    });
    expect(sent("/web/create_verification_intent")).toEqual([
      {
        body: {
          binding_id: "card-x2b",
          currency: "RUB",
          form_params: {
            flow: "card",
            integrationProfileId: "yandex_default",
            mode: "default",
            query_params: { lang: "ru", layout: "default", theme: "light" },
            type: "verification",
          },
        },
        path: "/web/create_verification_intent",
        query: "?service_token=taxifee_test",
      },
    ]);
  });

  it("makes no link for a card Go already takes or does not have", async () => {
    const usable = await goPage({
      "/3.0/paymentmethods": {
        body: { card: { available_cards: [{ ...mir, usable: true }] } },
      },
    });
    expect(
      dataOf(await runInPage(goCardVerifyOperation.run, verify, usable.page))
    ).toEqual({ kind: "verified" });
    const none = await goPage({
      "/3.0/paymentmethods": { body: { card: { available_cards: [visa] } } },
    });
    expect(
      dataOf(await runInPage(goCardVerifyOperation.run, verify, none.page))
    ).toEqual({ kind: "failed", reason: "card_not_found" });
    expect(none.sent("/web/create_verification_intent")).toHaveLength(0);
  });

  it("makes no link without Go's Trust token", async () => {
    const { page, sent } = await goPage({
      "/": { body: {} },
      "/3.0/paymentmethods": {
        body: { card: { available_cards: [mir], unverified_cards: [mir] } },
      },
    });
    expect(
      dataOf(await runInPage(goCardVerifyOperation.run, verify, page))
    ).toEqual({ kind: "failed", reason: "no_trust_token" });
    expect(sent("/web/create_verification_intent")).toHaveLength(0);
  });

  it.each<FakeResponse & { reason: string }>([
    {
      body: { message: "Validation failed" },
      reason: "trust_400",
      status: 400,
    },
    {
      body: { form_url: "https://example.com/web/binding?x=1" },
      reason: "trust_201",
      status: 201,
    },
  ])("passes on only Trust's own form ($reason)", async (answer) => {
    const { page } = await goPage({
      "/3.0/paymentmethods": {
        body: { card: { available_cards: [mir], unverified_cards: [mir] } },
      },
      "/web/create_verification_intent": answer,
    });
    expect(
      dataOf(await runInPage(goCardVerifyOperation.run, verify, page))
    ).toEqual({ kind: "failed", reason: answer.reason });
  });
});

describe("go.ride and go.cancel", () => {
  it("reads the ride that is on", async () => {
    const { page } = await goPage({
      "/3.0/launch": { body: activeLaunch },
      "/3.0/taxiontheway": { body: activeOrder },
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
      "/3.0/launch": { body: activeLaunch },
      "/3.0/taxiontheway": [
        { body: activeOrder },
        { body: { status: "cancelled" } },
      ],
    });
    expect(dataOf(await runInPage(goCancelOperation.run, {}, page))).toEqual({
      kind: "cancelled",
      orderId: "active-order",
    });
    expect(sent("/3.0/taxiontheway").at(-1)?.body).toMatchObject({
      orderid: "active-order",
      break: "user",
    });
  });

  it("leaves a ride Yandex no longer lets cancel, and says there is none to cancel", async () => {
    const locked = await goPage({
      "/3.0/launch": { body: activeLaunch },
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

import { describe, expect, it } from "vitest";
import { goEstimateOperation } from "@agent/lib/yandex/go/estimate";
import { goRidesOperation } from "@agent/lib/yandex/go/rides";
import type { JsonValue } from "@agent/lib/yandex/operations";
import { type FakeResponse, dataOf, fixture, runInPage } from "./page";

const userId = "0123456789abcdef0123456789abcdef";
const origin = "https://taxi.yandex.ru/";

/** The page's answers: the spec's fixtures, by the request's path. */
async function goPage(
  overrides: readonly (readonly [string, FakeResponse])[] = [],
  stored: JsonValue = { userId }
) {
  const answers = new Map<string, FakeResponse>([
    ["/3.0/routestats", { body: await fixture("go/routestats.json") }],
    [
      "/4.0/orderhistory/v2/list",
      { body: await fixture("go/orderhistory.json") },
    ],
    ["/4.0/persuggest/v1/suggest", { body: await fixture("go/suggest.json") }],
    ["/csrf_token", { body: await fixture("go/csrf-token.json") }],
    ...overrides,
  ]);
  const requests: { body?: string | null; path: string }[] = [];
  return {
    requests,
    page: {
      indexedDb: stored,
      origin,
      respond(url: URL, init: { body?: string | null }) {
        requests.push({ body: init.body, path: url.pathname });
        return answers.get(url.pathname) ?? { body: {}, status: 404 };
      },
    },
  };
}

type Place = string | [number, number];

const estimateArgs = (places: { from?: Place; to?: Place } = {}) =>
  goEstimateOperation.args.parse({
    from: "Красная площадь",
    to: "Парк Горького",
    ...places,
  });

describe("go.estimate", () => {
  it("prices the tariffs between two addresses and drops the hidden ones", async () => {
    const { page, requests } = await goPage();
    const answer = await runInPage(
      goEstimateOperation.run,
      estimateArgs({}),
      page
    );
    expect(answer).toEqual({
      data: {
        distance: "4,5 км",
        duration: "11 мин",
        from: "Москва, Красная площадь",
        tariffs: [
          {
            class: "econom",
            fixed: true,
            name: "Эконом",
            pickupMinutes: 7,
            price: 780,
          },
          {
            class: "business",
            fixed: true,
            name: "Комфорт",
            pickupMinutes: 9,
            price: 900,
          },
          {
            class: "comfortplus",
            fixed: true,
            name: "Комфорт+",
            pickupMinutes: 11,
            price: 1000,
          },
          {
            class: "minivan",
            fixed: false,
            name: "Минивэн",
            pickupMinutes: 26,
            price: 1100,
          },
        ],
        to: "Москва, Красная площадь",
      },
      status: "ok",
    });
    expect(goEstimateOperation.result.parse(dataOf(answer))).toBeDefined();
    const route = requests.find((r) => r.path === "/3.0/routestats");
    expect(JSON.parse(route?.body ?? "{}")).toMatchObject({
      id: userId,
      route: [
        [37.6212, 55.7535],
        [37.6212, 55.7535],
      ],
      selected_class: "econom",
    });
  });

  it("takes coordinates as they are, without geocoding them", async () => {
    const { page, requests } = await goPage();
    await runInPage(
      goEstimateOperation.run,
      estimateArgs({ from: [37.1, 55.1], to: [37.2, 55.2] }),
      page
    );
    expect(requests.map((r) => r.path)).toEqual([
      "/csrf_token",
      "/3.0/routestats",
    ]);
  });

  it("names the address that was not found, as data", async () => {
    const { page } = await goPage([
      ["/4.0/persuggest/v1/suggest", { body: { results: [] } }],
    ]);
    expect(
      await runInPage(goEstimateOperation.run, estimateArgs({}), page)
    ).toEqual({
      data: { error: "address_not_found", which: "from" },
      status: "ok",
    });
  });

  it("reports a signed-out page as the sign-in, and a session without a user id as an error", async () => {
    const signedOut = await goPage([
      ["/csrf_token", { body: {}, status: 401 }],
    ]);
    expect(
      await runInPage(goEstimateOperation.run, estimateArgs({}), signedOut.page)
    ).toEqual({ status: "signed_out" });
    const noUser = await goPage([], { userId: "not-a-user" });
    expect(
      await runInPage(goEstimateOperation.run, estimateArgs({}), noUser.page)
    ).toEqual({ data: { error: "no_user_id" }, status: "ok" });
  });

  it("answers only with the fields for the person", () => {
    const parsed = goEstimateOperation.result.parse({
      distance: "4,5 км",
      duration: "11 мин",
      from: "а",
      offer: "secret",
      tariffs: [],
      to: "б",
    });
    expect(parsed).not.toHaveProperty("offer");
  });
});

describe("go.rides", () => {
  it("lists the latest taxi rides without the driver, the car or the phone", async () => {
    const { page } = await goPage();
    const answer = await runInPage(
      goRidesOperation.run,
      goRidesOperation.args.parse({}),
      page
    );
    expect(answer).toEqual({
      data: {
        rides: [
          {
            currency: "RUB",
            date: "2026-10-09T12:00:00+0300",
            from: "Тестовая улица, 1",
            price: 450,
            status: "finished",
            tariff: "Эконом",
            to: "Придуманный переулок, 5",
          },
          expect.anything(),
        ],
      },
      status: "ok",
    });
    expect(JSON.stringify(answer)).not.toMatch(
      /Тест Водитель|А000АА000|driver|phone/u
    );
    expect(goRidesOperation.result.parse(dataOf(answer))).toBeDefined();
  });

  it("answers the sign-in wall as the sign-in", async () => {
    const { page } = await goPage([
      ["/4.0/orderhistory/v2/list", { body: {}, status: 401 }],
    ]);
    expect(
      await runInPage(
        goRidesOperation.run,
        goRidesOperation.args.parse({}),
        page
      )
    ).toEqual({ status: "signed_out" });
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  goBookOperation,
  goCancelOperation,
} from "@agent/lib/yandex/go/booking";
import { goEstimateOperation } from "@agent/lib/yandex/go/estimate";
import { goOpenOperation } from "@agent/lib/yandex/go/open";
import { goRidesOperation } from "@agent/lib/yandex/go/rides";
import type { JsonValue } from "@agent/lib/yandex/operations";
import {
  type FakePage,
  type FakeResponse,
  dataOf,
  fixture,
  overlap,
  runInPage,
} from "./page";

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

  it("looks both addresses up together and waits for nothing between requests", async () => {
    const { page, requests } = await goPage();
    const together = overlap(
      (url) => url.pathname === "/4.0/persuggest/v1/suggest",
      2
    );
    const timeouts: number[] = [];
    const answer = await runInPage(goEstimateOperation.run, estimateArgs({}), {
      ...page,
      hold: together.hold,
      timeouts,
    });
    expect(answer.status).toBe("ok");
    expect(together.overlapped()).toBe(true);
    expect(timeouts).toEqual([]);
    expect(requests.map((r) => r.path).at(-1)).toBe("/3.0/routestats");
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

  it("reports a signed-out page as the sign-in, and a session without a user id as none", async () => {
    const signedOut = await goPage([
      ["/csrf_token", { body: {}, status: 401 }],
    ]);
    expect(
      await runInPage(goEstimateOperation.run, estimateArgs({}), signedOut.page)
    ).toEqual({ status: "signed_out" });
    const noUser = await goPage([], { userId: "not-a-user" });
    expect(
      await runInPage(goEstimateOperation.run, estimateArgs({}), noUser.page)
    ).toEqual({ status: "no_session" });
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
});

describe("Go's own session in Bro's browser", () => {
  // 23.10: a new person's taxi failed three times on a browser that had never
  // opened Go, and the failed read left an empty database that kept Go's own
  // page from ever making its store.
  it("answers no_session, sending nothing and making no database, where Go was never opened", async () => {
    const { page, requests } = await goPage();
    const database = { state: "absent" as const };
    expect(
      await runInPage(goEstimateOperation.run, estimateArgs({}), {
        ...page,
        database,
      })
    ).toEqual({ status: "no_session" });
    expect(database.state).toBe("absent");
    expect(requests).toEqual([]);
  });

  it("deletes the empty database an older read left, so Go's page can make its store", async () => {
    const { page, requests } = await goPage();
    const deleted: string[] = [];
    const database: NonNullable<FakePage["database"]> = { state: "empty" };
    expect(
      await runInPage(goEstimateOperation.run, estimateArgs({}), {
        ...page,
        database,
        deleted,
      })
    ).toEqual({ status: "no_session" });
    expect(deleted).toEqual(["turboapp-taxi"]);
    expect(database.state).toBe("absent");
    expect(requests).toEqual([]);
  });

  it("does not use a session Go made while nobody was signed in to Yandex", async () => {
    const { page, requests } = await goPage([], {
      authStatus: "unauthorized",
      userId,
    });
    expect(
      await runInPage(goEstimateOperation.run, estimateArgs({}), page)
    ).toEqual({ status: "no_session" });
    expect(requests).toEqual([]);
  });

  it("books and cancels nothing without a session: no_session comes before any request", async () => {
    const { page, requests } = await goPage();
    const never = { ...page, database: { state: "absent" as const } };
    expect(
      await runInPage(
        goBookOperation.run,
        z.json().parse(
          goBookOperation.args.parse({
            from: "Мичуринский проспект, 56",
            to: "Гвидон",
          })
        ),
        never
      )
    ).toEqual({ status: "no_session" });
    expect(await runInPage(goCancelOperation.run, {}, never)).toEqual({
      status: "no_session",
    });
    expect(requests).toEqual([]);
  });

  it("opens Go's page and waits for its session, deleting nothing while Go's page is at work", async () => {
    const signedIn = await goPage([], { authStatus: "authorized", userId });
    expect(await runInPage(goOpenOperation.run, {}, signedIn.page)).toEqual({
      data: { opened: true },
      status: "ok",
    });
    const deleted: string[] = [];
    expect(
      await runInPage(
        goOpenOperation.run,
        {},
        {
          ...signedIn.page,
          database: { state: "empty" },
          deleted,
        }
      )
    ).toEqual({ status: "no_session" });
    expect(deleted).toEqual([]);
    expect(signedIn.requests).toEqual([]);
  });
});

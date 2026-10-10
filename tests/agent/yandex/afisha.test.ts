import { describe, expect, it } from "vitest";
import { afishaSearchOperation } from "@agent/lib/yandex/afisha/search";
import { afishaTicketsOperation } from "@agent/lib/yandex/afisha/tickets";
import { type FakeResponse, dataOf, fixture, runInPage } from "./page";

const origin = "https://afisha.yandex.ru/moscow";

async function afishaPage(answer: FakeResponse) {
  const requests: { body?: string | null; url: URL }[] = [];
  return {
    requests,
    page: {
      origin,
      respond(url: URL, init: { body?: string | null }) {
        requests.push({ body: init.body, url });
        return answer;
      },
    },
  };
}

describe("afisha.search", () => {
  it("lists the events of a query with their kind, venue, dates and lowest price", async () => {
    const { page, requests } = await afishaPage({
      body: await fixture("afisha/search.json"),
    });
    const answer = await runInPage(
      afishaSearchOperation.run,
      afishaSearchOperation.args.parse({ query: "джаз" }),
      page
    );
    expect(answer).toEqual({
      data: {
        events: [
          {
            id: "000000000000000000000001",
            kind: "Концерт",
            minPrice: 1500,
            sale: "available",
            title: "Тестовый джаз",
            url: "https://afisha.yandex.ru/moscow/concert/testovyj-dzhaz",
            venue: "Тестовый зал",
            when: "15 окт",
          },
          {
            id: "000000000000000000000002",
            kind: "Концерт",
            minPrice: null,
            sale: null,
            title: "Вымышленный фестиваль",
            url: "https://afisha.yandex.ru/moscow/concert/vymyshlennyj-festival",
            venue: "в 3 местах",
            when: "Октябрь — декабрь",
          },
        ],
      },
      status: "ok",
    });
    expect(afishaSearchOperation.result.parse(dataOf(answer))).toBeDefined();
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      variables: { docs: 10, text: "джаз" },
    });
    expect(requests[0]?.url.searchParams.get("query_name")).toBe("BroSearch");
  });

  it("names a GraphQL error as data, not as its text", async () => {
    const { page } = await afishaPage({
      body: await fixture("afisha/error-validation.json"),
      status: 200,
    });
    expect(
      await runInPage(
        afishaSearchOperation.run,
        afishaSearchOperation.args.parse({ query: "джаз" }),
        page
      )
    ).toEqual({ data: { error: "gql" }, status: "ok" });
  });

  it("refuses a city that is not a slug", () => {
    expect(
      afishaSearchOperation.args.safeParse({ city: "../x", query: "джаз" })
        .success
    ).toBe(false);
  });
});

describe("afisha.tickets", () => {
  it("lists the person's orders with the event, the seats and the total, without the ticket files", async () => {
    const { page } = await afishaPage({
      body: await fixture("afisha/orders.json"),
    });
    const answer = await runInPage(
      afishaTicketsOperation.run,
      afishaTicketsOperation.args.parse({}),
      page
    );
    expect(answer).toEqual({
      data: {
        orders: [
          {
            address: "Москва, Тестовая улица, 1",
            event: "Тестовый спектакль",
            id: "000000000000000000000009",
            number: "0000000",
            passed: false,
            seats: ["Партер, ряд 5, место 7", "Партер, ряд 5, место 8"],
            tickets: 2,
            total: 3000,
            venue: "Тестовый театр",
            when: "2026-10-20T19:00:00+03:00",
          },
        ],
        total: 1,
      },
      status: "ok",
    });
    expect(afishaTicketsOperation.result.parse(dataOf(answer))).toBeDefined();
    expect(JSON.stringify(answer)).not.toMatch(
      /orderPdf|widgetUrl|orderQrCode/u
    );
  });

  it("answers an empty list as an empty list", async () => {
    const { page } = await afishaPage({
      body: await fixture("afisha/orders-empty.json"),
    });
    expect(
      await runInPage(
        afishaTicketsOperation.run,
        afishaTicketsOperation.args.parse({}),
        page
      )
    ).toEqual({ data: { orders: [], total: 0 }, status: "ok" });
  });

  it("answers the sign-in wall as such", async () => {
    const { page } = await afishaPage({ body: {}, status: 401 });
    expect(
      await runInPage(
        afishaTicketsOperation.run,
        afishaTicketsOperation.args.parse({}),
        page
      )
    ).toEqual({ status: "signed_out" });
  });
});

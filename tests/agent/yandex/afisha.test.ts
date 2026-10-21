import { describe, expect, it } from "vitest";
import * as z from "zod";
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

/**
 * A page whose listing answers by the words asked for: the fixture's events,
 * none, or a GraphQL error. `searches` are the words of each request, in order.
 */
async function searchingPage(
  answerFor: (search: string | null) => "empty" | "error" | "listing"
) {
  const answers = {
    empty: { body: await fixture("afisha/listing-empty.json") },
    error: { body: await fixture("afisha/error-validation.json") },
    listing: { body: await fixture("afisha/listing.json") },
  };
  const searches: (string | null)[] = [];
  return {
    page: {
      origin,
      respond(_url: URL, init: { body?: string | null }) {
        const { variables } = z
          .object({ variables: z.object({ search: z.string().nullable() }) })
          .parse(JSON.parse(init.body ?? "{}"));
        searches.push(variables.search);
        return answers[answerFor(variables.search)];
      },
    },
    searches,
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

  it("lists a kind of event for days, with the dates worded for those days", async () => {
    const { page, requests } = await afishaPage({
      body: await fixture("afisha/listing.json"),
    });
    const answer = await runInPage(
      afishaSearchOperation.run,
      afishaSearchOperation.args.parse({
        category: "concert",
        from: "2026-10-24",
        to: "2026-10-25",
      }),
      page
    );
    expect(answer).toEqual({
      data: {
        events: [
          {
            id: "000000000000000000000003",
            kind: "Концерт",
            minPrice: 1500,
            sale: "available",
            title: "Тестовый джаз",
            url: "https://afisha.yandex.ru/moscow/concert/testovyj-dzhaz",
            venue: "Тестовый зал",
            when: "сб 24 окт, 19:00",
          },
          {
            id: "000000000000000000000004",
            kind: "Кино",
            minPrice: null,
            sale: null,
            title: "Вымышленный фильм",
            url: "https://afisha.yandex.ru/moscow/cinema/vymyshlennyj-film",
            venue: "в 3 кинотеатрах",
            when: null,
          },
        ],
      },
      status: "ok",
    });
    expect(afishaSearchOperation.result.parse(dataOf(answer))).toBeDefined();
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      operationName: "BroListing",
      variables: {
        dates: { date: "2026-10-24", period: 2 },
        paging: { limit: 10, offset: 0 },
        search: null,
        tags: ["concert"],
      },
    });
  });

  it("counts the days from the first to the last, both included, and keeps words and no days apart", async () => {
    const askedFor = async (
      args: z.input<typeof afishaSearchOperation.args>
    ) => {
      const { page, requests } = await afishaPage({
        body: await fixture("afisha/listing.json"),
      });
      await runInPage(
        afishaSearchOperation.run,
        afishaSearchOperation.args.parse(args),
        page
      );
      return z
        .object({ variables: z.json() })
        .parse(JSON.parse(requests[0]?.body ?? "{}"));
    };
    expect(
      await askedFor({ category: "cinema", from: "2026-10-26" })
    ).toMatchObject({
      variables: { dates: { date: "2026-10-26", period: 1 }, tags: ["cinema"] },
    });
    expect(
      await askedFor({
        category: "theatre",
        from: "2026-10-26",
        to: "2026-11-01",
      })
    ).toMatchObject({
      variables: {
        dates: { date: "2026-10-26", period: 7 },
        tags: ["theatre"],
      },
    });
    expect(
      await askedFor({ category: "concert", query: "джаз" })
    ).toMatchObject({
      variables: { dates: null, search: "джаз", tags: ["concert"] },
    });
    expect(await askedFor({})).toMatchObject({
      variables: { dates: null, search: null, tags: null },
    });
  });

  it("answers days that are none without asking Afisha", async () => {
    const { page, requests } = await afishaPage({
      body: await fixture("afisha/listing.json"),
    });
    const answers = await Promise.all(
      [
        { to: "2026-10-25" },
        { from: "2026-10-25", to: "2026-10-24" },
        { from: "2026-02-30" },
      ].map((days) =>
        runInPage(
          afishaSearchOperation.run,
          afishaSearchOperation.args.parse({ category: "concert", ...days }),
          page
        )
      )
    );
    expect(answers).toEqual(
      Array.from({ length: 3 }, () => ({
        data: { error: "bad_dates" },
        status: "ok",
      }))
    );
    expect(requests).toEqual([]);
  });

  it("asks once more without the words when no title has them, and says which words", async () => {
    const { page, searches } = await searchingPage((search) =>
      search === null ? "listing" : "empty"
    );
    const args = afishaSearchOperation.args.parse({
      category: "concert",
      from: "2026-10-24",
      query: "концерт",
    });
    const answer = await runInPage(afishaSearchOperation.run, args, page);
    expect(searches).toEqual(["концерт", null]);
    expect(dataOf(answer)).toMatchObject({
      events: [{ title: "Тестовый джаз" }, { title: "Вымышленный фильм" }],
      queryDropped: "концерт",
    });
    expect(afishaSearchOperation.result.parse(dataOf(answer))).toBeDefined();
  });

  it("does not ask again when the first ask failed, when there were no words, or when the kind has nothing either", async () => {
    const asked = async (
      args: z.input<typeof afishaSearchOperation.args>,
      answerFor: (search: string | null) => "empty" | "error" | "listing"
    ) => {
      const { page, searches } = await searchingPage(answerFor);
      const answer = await runInPage(
        afishaSearchOperation.run,
        afishaSearchOperation.args.parse(args),
        page
      );
      return { data: dataOf(answer), searches };
    };
    const words = { category: "concert", query: "концерт" } as const;
    expect(await asked(words, () => "error")).toEqual({
      data: { error: "gql" },
      searches: ["концерт"],
    });
    expect(await asked({ category: "concert" }, () => "empty")).toEqual({
      data: { events: [] },
      searches: [null],
    });
    expect(await asked(words, () => "empty")).toEqual({
      data: { events: [] },
      searches: ["концерт", null],
    });
  });

  it("takes a model's blank fields as no filter", () => {
    expect(
      afishaSearchOperation.args.parse({
        category: "",
        from: "",
        query: "джаз",
        to: "",
      })
    ).toMatchObject({ category: "", from: "", query: "джаз", to: "" });
    expect(
      afishaSearchOperation.args.safeParse({ category: "концерты" }).success
    ).toBe(false);
    expect(
      afishaSearchOperation.args.safeParse({ from: "в субботу" }).success
    ).toBe(false);
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

import { describe, expect, it } from "vitest";
import { mapsOrgOperation } from "@agent/lib/yandex/maps/org";
import {
  mapsSearchOperation,
  sameBuildingNote,
} from "@agent/lib/yandex/maps/search";
import { type FakeResponse, dataOf, fixture, runInPage } from "./page";

const origin = "https://yandex.ru/robots.txt";
const scripts = [
  '{"config":{"csrfToken":"abc0123:1790000000","sessionId":"s1-BAL"}}',
];

/**
 * The signature of Maps' requests, written apart from the operations' own
 * code: a BigInt reading of the spec's hash, over the query as sent.
 */
function referenceSign(text: string) {
  let h = 5381n;
  for (const b of new TextEncoder().encode(text)) {
    h = ((33n * h) ^ BigInt(b)) & 0xffffffffn;
  }
  return Number(h);
}

/**
 * The page's answers by path, in order: a path with several answers gives
 * them one after another, and the last one again after that. A `uri` search
 * (the card) is the same path as the search, so it has its own key.
 */
async function mapsPage(
  answers: readonly (readonly [string, FakeResponse | FakeResponse[]])[],
  pageScripts: readonly string[] = scripts
) {
  const requests: URL[] = [];
  const queue = new Map<string, FakeResponse[]>(
    answers.map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ])
  );
  return {
    requests,
    page: {
      origin,
      scripts: pageScripts,
      respond(url: URL) {
        requests.push(url);
        const card = url.searchParams.get("mode") === "uri";
        const next =
          (card ? queue.get(`${url.pathname}?card`) : undefined) ??
          queue.get(url.pathname);
        const answer = next && (next.length > 1 ? next.shift() : next[0]);
        return answer ?? { body: {}, status: 404 };
      },
    },
  };
}

const orgFixtures = async () => ({
  card: await fixture("maps/org.json"),
  reviews: await fixture("maps/reviews.json"),
  slots: await fixture("maps/booking-timeslots.json"),
});

describe("maps.search", () => {
  it("lists the places of a query, with their rating, hours and booking, and signs each request", async () => {
    const { page, requests } = await mapsPage([
      ["/maps/api/search", { body: await fixture("maps/search.json") }],
    ]);
    const answer = await runInPage(
      mapsSearchOperation.run,
      mapsSearchOperation.args.parse({ limit: 3, query: "пиццерия" }),
      page
    );
    expect(answer).toMatchObject({ status: "ok" });
    const parsed = mapsSearchOperation.result.parse(dataOf(answer));
    const places = "places" in parsed ? parsed.places : [];
    expect(places.length).toBeLessThanOrEqual(3);
    expect(
      places.find((place) => place.name === "Тестовая Пиццерия")
    ).toMatchObject({
      bookable: true,
      rating: 4.6,
      ratingCount: 1200,
    });

    const raw = requests[0]?.search.slice(1) ?? "";
    const [signedQuery, signature] = raw.split("&s=");
    expect(requests[0]?.searchParams.get("text")).toBe("пиццерия");
    expect(Number(signature)).toBe(referenceSign(signedQuery ?? ""));
  });

  it("takes a stale token once, from the answer that carries the new one", async () => {
    const { page, requests } = await mapsPage([
      [
        "/maps/api/search",
        [
          { body: await fixture("maps/csrf-retry.json") },
          { body: await fixture("maps/search.json") },
        ],
      ],
    ]);
    const answer = await runInPage(
      mapsSearchOperation.run,
      mapsSearchOperation.args.parse({ query: "пиццерия" }),
      page
    );
    expect(answer).toMatchObject({ status: "ok" });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.searchParams.get("csrfToken")).toBe(
      "0000000000000000000000000000000000000000:1790000000"
    );
  });

  it("answers the sign-in wall as such", async () => {
    const signedOut = await mapsPage([
      ["/maps/api/search", { body: {}, status: 401 }],
    ]);
    expect(
      await runInPage(
        mapsSearchOperation.run,
        mapsSearchOperation.args.parse({ query: "x" }),
        signedOut.page
      )
    ).toEqual({ status: "signed_out" });
  });

  it("asks with a session of its own on a page without one and takes the token the API gives", async () => {
    const { page, requests } = await mapsPage(
      [
        [
          "/maps/api/search",
          [
            { body: await fixture("maps/csrf-retry.json") },
            { body: await fixture("maps/search.json") },
          ],
        ],
      ],
      ["{}"]
    );
    const answer = await runInPage(
      mapsSearchOperation.run,
      mapsSearchOperation.args.parse({ query: "пиццерия" }),
      page
    );
    expect(answer).toMatchObject({ status: "ok" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.searchParams.get("csrfToken")).toBe("");
    const session = requests[0]?.searchParams.get("sessionId");
    expect(session).toMatch(/^\d+_\d+$/u);
    expect(requests[1]?.searchParams.get("sessionId")).toBe(session);
    expect(requests[1]?.searchParams.get("csrfToken")).toBe(
      "0000000000000000000000000000000000000000:1790000000"
    );
  });
});

/** A salon of Yandex Maps' search at a point, or with none. */
const salon = (id: string, name: string, at: [number, number] | null) => ({
  address: "Москва, Мичуринский проспект, 56",
  bookable: true,
  category: "Парикмахерская",
  coordinates: at,
  hours: null,
  id,
  name,
  openNow: null,
  openText: null,
  phone: null,
  rating: null,
  ratingCount: null,
  site: null,
  url: `https://yandex.ru/maps/org/x/${id}/`,
});

describe("places in one building", () => {
  it("names the places of each building so Bro asks which one the person means", () => {
    // 23.10: two salons at Мичуринский, 56; Bro went to book at the first.
    const note = sameBuildingNote({
      places: [
        salon("1", "Glow&Go", [37.4805, 55.6935]),
        salon("2", "Топган", [37.4808, 55.6937]),
        salon("3", "Чародейка", [37.5, 55.7]),
        // Another building a kilometre and more away, with two of its own.
        salon("4", "Персона", [37.52, 55.71]),
        salon("5", "Цирюльник", [37.5203, 55.7101]),
      ],
      total: 5,
    });

    expect(note).toContain(
      "«Glow&Go», «Топган» (Москва, Мичуринский проспект, 56); «Персона», «Цирюльник»"
    );
    expect(note).not.toContain("Чародейка");
    expect(note).toContain("ask which one before you book");
  });

  it("says nothing when no two places stand together", () => {
    expect(
      sameBuildingNote({
        places: [
          salon("1", "Glow&Go", [37.4805, 55.6935]),
          salon("2", "Топган", null),
          salon("3", "Чародейка", [37.5, 55.7]),
        ],
        total: 3,
      })
    ).toBeUndefined();
    expect(sameBuildingNote({ error: "wall" })).toBeUndefined();
  });
});

describe("maps.org", () => {
  it("answers the card, the short reviews and the free times of the booking on the date", async () => {
    const { card, reviews, slots } = await orgFixtures();
    const { page } = await mapsPage([
      ["/maps/api/search", { body: card }],
      ["/maps/api/business/fetchReviews", { body: reviews }],
      ["/web-maps/api/slow/booking/getTimeslots", { body: slots }],
    ]);
    const answer = await runInPage(
      mapsOrgOperation.run,
      mapsOrgOperation.args.parse({ date: "2026-10-12", id: "1000000000001" }),
      page
    );
    expect(answer).toMatchObject({
      data: {
        address: "Москва, Тестовая улица, 1",
        booking: {
          date: "2026-10-12",
          guests: 2,
          partner: "Яндекс Еда",
          slots: ["12:00", "12:40", "13:20"],
          type: "restaurant",
        },
        category: "Пиццерия",
        hours: "ежедневно, 10:00–22:00",
        id: "1000000000001",
        name: "Тестовая Пиццерия",
        openNow: true,
        phone: "+7 (495) 000-00-01",
        rating: 4.6,
        ratingCount: 1200,
        reviews: [
          { date: "2026-10-01", rating: 5, text: "Хорошее место." },
          { date: "2026-09-20", rating: 3, text: "Долго ждали заказ!" },
        ],
        site: "https://pizza.example.test/",
      },
      status: "ok",
    });
    const parsed = mapsOrgOperation.result.parse(dataOf(answer));
    const week = "week" in parsed ? parsed.week : [];
    expect(week).toHaveLength(7);
    expect(week[0]).toBe("10:00-22:00");
  });

  it("gives no booking without a date, and no slots when the booking answers with an error", async () => {
    const { card, reviews } = await orgFixtures();
    const { page } = await mapsPage([
      ["/maps/api/search", { body: card }],
      ["/maps/api/business/fetchReviews", { body: reviews }],
    ]);
    const noDate = await runInPage(
      mapsOrgOperation.run,
      mapsOrgOperation.args.parse({ id: "1000000000001" }),
      page
    );
    expect(noDate).toMatchObject({ data: { booking: null }, status: "ok" });

    const failing = await mapsPage([
      ["/maps/api/search", { body: card }],
      ["/maps/api/business/fetchReviews", { body: reviews }],
      [
        "/web-maps/api/slow/booking/getTimeslots",
        { body: { error: { code: 500 } } },
      ],
    ]);
    const withError = await runInPage(
      mapsOrgOperation.run,
      mapsOrgOperation.args.parse({ date: "2026-10-12", id: "1000000000001" }),
      failing.page
    );
    expect(withError).toMatchObject({
      data: { booking: { slots: null } },
      status: "ok",
    });
  });

  it("names a place that is not found, and refuses an id that is not a number", async () => {
    const { page } = await mapsPage([
      [
        "/maps/api/search",
        { body: { data: { items: [], totalResultCount: 0 } } },
      ],
    ]);
    expect(
      await runInPage(
        mapsOrgOperation.run,
        mapsOrgOperation.args.parse({ id: "1000000000001" }),
        page
      )
    ).toEqual({ data: { error: "not_found" }, status: "ok" });
    expect(mapsOrgOperation.args.safeParse({ id: "../../etc" }).success).toBe(
      false
    );
  });
});

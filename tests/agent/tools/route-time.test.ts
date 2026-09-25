import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const principal = {
  attributes: { workspaceId: "personal:workspace" },
  authenticator: "photon-imessage",
  principalId: "user-1",
  principalType: "user",
};

const toolContext = {
  abortSignal: new AbortController().signal,
  callId: "call-1",
  async getSandbox() {
    throw new Error("route_time uses no sandbox.");
  },
  getSkill() {
    throw new Error("route_time uses no skill.");
  },
  async getToken() {
    throw new Error("route_time uses no token.");
  },
  requireAuth() {
    throw new Error("route_time needs no authorization.");
  },
  session: {
    auth: { current: principal, initiator: null },
    id: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  },
  toolName: "route_time",
} satisfies ToolContext;

function resolveContext(authenticator: string, scheduledRunKind?: string) {
  const current = { ...principal, authenticator };
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current,
        initiator: scheduledRunKind
          ? {
              ...current,
              attributes: { ...current.attributes, scheduledRunKind },
            }
          : null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

/** The places this test's geocoder knows, by the exact query. */
const places = new Map([
  [
    "отель Метрополь, Москва",
    {
      address: {
        city: "Москва",
        country_code: "ru",
        house_number: "2",
        road: "Театральный проезд",
      },
      display_name: "Метрополь, 2, Театральный проезд, Москва, Россия",
      lat: "55.7584264",
      lon: "37.6214880",
      name: "Метрополь",
    },
  ],
  [
    "метро Чистые пруды, Москва",
    {
      address: { city: "Москва", country_code: "ru" },
      display_name: "Метро «Чистые пруды», Москва, Россия",
      lat: "55.76488",
      lon: "37.63802",
      name: "Метро «Чистые пруды»",
    },
  ],
  [
    "Чистопрудный бульвар 12, Москва",
    {
      address: {
        city: "Москва",
        country_code: "ru",
        house_number: "12",
        road: "Чистопрудный бульвар",
      },
      display_name: "12, Чистопрудный бульвар, Москва, Россия",
      lat: "55.7616",
      lon: "37.6415",
    },
  ],
  [
    "Метрополь, Москва",
    {
      address: { city: "Москва", country_code: "ru", house_number: "2" },
      display_name: "Метрополь, 2, Театральный проезд, Москва, Россия",
      lat: "55.7584264",
      lon: "37.6214880",
      name: "Метрополь",
    },
  ],
  [
    "Тверская улица 7, Москва",
    {
      address: {
        city: "Москва",
        country_code: "ru",
        house_number: "12 с7",
        road: "Тверская улица",
      },
      display_name: "12 с7, Тверская улица, Москва, Россия",
      lat: "55.76396",
      lon: "37.60874",
    },
  ],
  [
    "Чистопрудный бульвар 12 к2, Москва",
    {
      address: {
        city: "Москва",
        country_code: "ru",
        house_number: "12 к2",
        road: "Чистопрудный бульвар",
      },
      addresstype: "building",
      display_name: "12 к2, Чистопрудный бульвар, Москва, Россия",
      lat: "55.76056",
      lon: "37.64255",
    },
  ],
  [
    "Большая Никольская 12 с2, Москва",
    {
      address: {
        city: "Москва",
        country_code: "ru",
        road: "Большая Никольская улица",
      },
      addresstype: "road",
      display_name: "Большая Никольская улица, Москва, Россия",
      lat: "55.7532",
      lon: "37.6178",
    },
  ],
  [
    // Nominatim answers a query that ends in a city with the city itself.
    "Москва, Россия",
    {
      address: { city: "Москва", country_code: "ru" },
      addresstype: "city",
      display_name: "Москва, Центральный федеральный округ, Россия",
      lat: "55.7505",
      lon: "37.6175",
      name: "Москва",
      place_rank: 16,
    },
  ],
  [
    "Кафе Призрак, Москва",
    {
      address: { city: "Москва", country_code: "ru" },
      addresstype: "city",
      display_name: "Москва, Центральный федеральный округ, Россия",
      lat: "55.7505",
      lon: "37.6175",
      name: "Москва",
      place_rank: 16,
    },
  ],
  [
    "Москва",
    {
      address: { city: "Москва", country_code: "ru" },
      addresstype: "city",
      display_name: "Москва, Центральный федеральный округ, Россия",
      lat: "55.7505",
      lon: "37.6175",
      name: "Москва",
      place_rank: 16,
    },
  ],
  [
    "Тверь",
    {
      address: { city: "Тверь", country_code: "ru" },
      addresstype: "city",
      display_name: "Тверь, Тверская область, Россия",
      lat: "56.8587",
      lon: "35.9176",
      name: "Тверь",
      place_rank: 16,
    },
  ],
  [
    "Городская поликлиника 2, Москва",
    {
      address: {
        city: "Москва",
        country_code: "ru",
        house_number: "15",
        road: "Сретенка",
      },
      addresstype: "amenity",
      display_name: "Городская поликлиника № 2, 15, Сретенка, Москва, Россия",
      lat: "55.7702",
      lon: "37.6325",
      name: "Городская поликлиника № 2",
      place_rank: 30,
    },
  ],
  [
    "Школа 57, Москва",
    {
      address: {
        city: "Москва",
        country_code: "ru",
        house_number: "7/10 с5",
        road: "Малый Знаменский переулок",
      },
      addresstype: "amenity",
      display_name: "Школа № 57, 7/10 с5, Малый Знаменский переулок, Москва",
      lat: "55.7478",
      lon: "37.6035",
      name: "Школа № 57",
      place_rank: 30,
    },
  ],
  [
    "Times Square, New York",
    {
      address: { city: "New York", country_code: "us" },
      display_name: "Times Square, Manhattan, New York, United States",
      lat: "40.7580",
      lon: "-73.9855",
      name: "Times Square",
    },
  ],
  [
    "Central Park, New York",
    {
      address: { city: "New York", country_code: "us" },
      display_name: "Central Park, Manhattan, New York, United States",
      lat: "40.7812",
      lon: "-73.9665",
      name: "Central Park",
    },
  ],
]);

const fetchMock = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>();
/** When each request reached the network, by the fake clock. */
const requestTimes: { readonly at: number; readonly host: string }[] = [];

function geocoderAnswer(url: URL) {
  const place = places.get(url.searchParams.get("q") ?? "");
  return Response.json(place ? [place] : []);
}

/** A table answer with 1.6 km and 21 min per destination, 0.7 km and 10 min for the next. */
function routerAnswer(url: URL) {
  const count = (url.searchParams.get("destinations") ?? "").split(";").length;
  const durations = [1286.1, 582.2, 900, 900, 900].slice(0, count);
  const distances = [1608.2, 727.6, 1000, 1000, 1000].slice(0, count);
  return Response.json({
    code: "Ok",
    distances: [distances],
    durations: [durations],
  });
}

const outputSchema = z.object({
  attribution: z.string().optional(),
  basis: z.string().optional(),
  from: z.string().optional(),
  fromNote: z.string().optional(),
  note: z.string().optional(),
  routes: z
    .array(
      z.object({
        error: z.string().optional(),
        km: z.number().optional(),
        link: z.string().optional(),
        minutes: z.number().optional(),
        note: z.string().optional(),
        place: z.string().optional(),
        straightKm: z.number().optional(),
        to: z.string(),
      })
    )
    .optional(),
  status: z.enum(["ok", "not_found", "unavailable"]),
});

async function measure(input: {
  readonly from: string;
  readonly mode: "cycling" | "driving" | "walking";
  readonly to: readonly string[];
}) {
  const { routeTime } = await import("@agent/tools/route_time");
  const pending = routeTime.execute(
    { ...input, to: [...input.to] },
    toolContext
  );
  await vi.runAllTimersAsync();
  const result = await pending;
  if (Symbol.asyncIterator in result) {
    throw new Error("route_time returns one result, not a stream.");
  }
  return outputSchema.parse(result);
}

function requestsTo(host: string) {
  return fetchMock.mock.calls
    .map(([url]) => url)
    .filter((url) => url.host === host);
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  requestTimes.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) => {
    requestTimes.push({ at: Date.now(), host: url.host });
    return url.host === "nominatim.openstreetmap.org"
      ? geocoderAnswer(url)
      : routerAnswer(url);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("route_time", () => {
  it("is offered in conversations and user-set tasks, not Bro's own checks or reports", async () => {
    const tools = (await import("@agent/tools/route_time")).default;
    const resolve = tools.events["turn.started"];
    if (!resolve) throw new Error("route_time resolves per turn.");
    const names = async (authenticator: string, kind?: string) =>
      Object.keys(
        (await resolve({}, resolveContext(authenticator, kind))) ?? {}
      );

    expect(await names("photon-imessage")).toEqual(["route_time"]);
    expect(await names("scheduled-worker")).toEqual(["route_time"]);
    expect(await names("scheduled-worker", "proactive")).toEqual([]);
    expect(await names("scheduled-result")).toEqual([]);
  });

  it("measures walks from one start to several places in one routing request", async () => {
    const result = await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["метро Чистые пруды, Москва", "Чистопрудный бульвар 12, Москва"],
    });

    expect(result).toMatchObject({
      from: "Метрополь, Театральный проезд 2, Москва",
      routes: [
        {
          km: 1.6,
          minutes: 21,
          place: "Метро «Чистые пруды», Москва",
          to: "метро Чистые пруды, Москва",
        },
        { km: 0.7, minutes: 10, to: "Чистопрудный бульвар 12, Москва" },
      ],
      status: "ok",
    });
    expect(result.basis).toContain("Walking");
    // The services' terms ask for the credit wherever their data is shown.
    expect(result.attribution).toBe("© OpenStreetMap");
    expect(result.routes?.[0]?.link).toBe(
      "https://yandex.ru/maps/?rtext=55.758426,37.621488~55.764880,37.638020&rtt=pd"
    );

    const [route, ...others] = requestsTo("routing.openstreetmap.de");
    expect(others).toEqual([]);
    expect(route?.pathname).toBe(
      "/routed-foot/table/v1/driving/37.621488,55.758426;37.638020,55.764880;37.641500,55.761600"
    );
    expect(route?.searchParams.get("sources")).toBe("0");
    expect(route?.searchParams.get("destinations")).toBe("1;2");

    // Destinations are looked for around the start first.
    const geocoded = requestsTo("nominatim.openstreetmap.org");
    expect(geocoded.map((url) => url.searchParams.get("viewbox"))).toEqual([
      null,
      "37.1,56.1,38.1,55.5",
      "37.1,56.1,38.1,55.5",
    ]);
  });

  it("identifies itself with a contact and keeps each instance to half the allowed rate", async () => {
    await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["метро Чистые пруды, Москва", "Чистопрудный бульвар 12, Москва"],
    });

    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get("user-agent")).toBe(
        "Bro/1.0 (personal assistant, route times; contact: https://example.com)"
      );
    }
    const geocoder = requestTimes.filter(
      (request) => request.host === "nominatim.openstreetmap.org"
    );
    expect(geocoder).toHaveLength(3);
    const gaps = geocoder
      .slice(1)
      .map((request, index) => request.at - (geocoder[index]?.at ?? 0));
    expect(gaps.every((gap) => gap >= 2000)).toBe(true);
  });

  it("stops looking places up after eight lookups in one call", async () => {
    const result = await measure({
      from: "Метрополь, Москва",
      mode: "walking",
      to: [
        "Кафе Один, Улица Первая 1, Москва",
        "Кафе Два, Улица Вторая 2, Москва",
        "Кафе Три, Улица Третья 3, Москва",
        "Кафе Четыре, Улица Четвёртая 4, Москва",
      ],
    });

    expect(requestsTo("nominatim.openstreetmap.org")).toHaveLength(8);
    expect(
      result.routes?.map((route) =>
        route.error?.includes("already made 8 map lookups")
      )
    ).toEqual([false, false, true, true]);
    expect(result.routes?.[0]?.error).toContain("not on the map");
  });

  it("answers a place and a route it already measured without asking again", async () => {
    const input = {
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["метро Чистые пруды, Москва"],
    } as const;
    const first = await measure(input);
    const calls = fetchMock.mock.calls.length;

    expect(await measure(input)).toEqual(first);
    expect(fetchMock.mock.calls).toHaveLength(calls);
  });

  it("takes coordinates as they are and tries a named place by its address", async () => {
    const result = await measure({
      from: "55.7584, 37.6215",
      mode: "walking",
      to: ["Кафе Авокадо, Чистопрудный бульвар 12, Москва"],
    });

    expect(result.routes?.[0]).toMatchObject({ km: 1.6, minutes: 21 });
    expect(
      requestsTo("nominatim.openstreetmap.org").map((url) =>
        url.searchParams.get("q")
      )
    ).toEqual([
      "Кафе Авокадо, Чистопрудный бульвар 12, Москва",
      "Чистопрудный бульвар 12, Москва",
    ]);
  });

  it("writes Russian houses the way the map knows them", async () => {
    const result = await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: [
        "Чистопрудный бульвар д. 12 корп. 2, Москва",
        "Чистопрудный бульвар 12, корп 2, Москва",
      ],
    });

    expect(result.routes?.map((route) => route.place)).toEqual([
      "Чистопрудный бульвар 12 к2, Москва",
      "Чистопрудный бульвар 12 к2, Москва",
    ]);
    expect(result.routes?.every((route) => route.minutes !== undefined)).toBe(
      true
    );
    expect(
      requestsTo("nominatim.openstreetmap.org")
        .map((url) => url.searchParams.get("q"))
        .slice(1)
    ).toEqual(["Чистопрудный бульвар 12 к2, Москва"]);
  });

  it("gives no time to a house the map knows only as its street", async () => {
    const result = await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["Большая Никольская 12 стр 2, Москва", "метро Чистые пруды, Москва"],
    });

    expect(result.routes?.[0]?.error).toContain(
      "found only the street «Большая Никольская улица, Москва»"
    );
    expect(result.routes?.[0]?.minutes).toBeUndefined();
    expect(result.routes?.[1]).toMatchObject({ km: 1.6, minutes: 21 });
    // Only the house it found is measured.
    expect(
      requestsTo("routing.openstreetmap.de")[0]?.searchParams.get(
        "destinations"
      )
    ).toBe("1");

    const fromStreet = await measure({
      from: "Большая Никольская 12 стр 2, Москва",
      mode: "walking",
      to: ["метро Чистые пруды, Москва"],
    });
    expect(fromStreet.status).toBe("not_found");
    expect(fromStreet.note).toContain("found only the street");
  });

  it("never measures to a city when the query named a place in it", async () => {
    // «Тверская 7, Москва, Россия» must not be cut down to «Москва, Россия».
    const street = await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["Тверская 7, Москва, Россия"],
    });
    expect(
      requestsTo("nominatim.openstreetmap.org").map((url) =>
        url.searchParams.get("q")
      )
    ).not.toContain("Москва, Россия");
    expect(street.routes?.[0]?.error).toContain("not on the map");

    // The map answering a place with its city gets no time either.
    const cafe = await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["Кафе Призрак, Москва"],
    });
    expect(cafe.routes?.[0]?.error).toContain("found only the area «Москва»");
    expect(cafe.routes?.[0]?.minutes).toBeUndefined();
  });

  it("measures between cities the person named, to their centres", async () => {
    const result = await measure({
      from: "Москва",
      mode: "driving",
      to: ["Тверь"],
    });

    expect(result.status).toBe("ok");
    expect(result.fromNote).toContain("centre of «Москва»");
    expect(result.routes?.[0]?.note).toContain("centre of «Тверь»");
    expect(result.routes?.[0]?.minutes).toBeDefined();
  });

  it("does not take a number in a place's name for a house", async () => {
    const result = await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["Городская поликлиника 2, Москва", "Школа 57, Москва"],
    });

    expect(result.routes?.map((route) => route.error)).toEqual([
      undefined,
      undefined,
    ]);
    expect(result.routes?.[0]?.place).toBe(
      "Городская поликлиника № 2, Сретенка 15, Москва"
    );
  });

  it("drops the kind of place and quotes that the map reads as part of the name", async () => {
    const result = await measure({
      from: "гостиница «Метрополь», Москва",
      mode: "walking",
      to: ["метро Чистые пруды, Москва"],
    });

    expect(result.status).toBe("ok");
    expect(
      requestsTo("nominatim.openstreetmap.org")
        .map((url) => url.searchParams.get("q"))
        .slice(0, 2)
    ).toEqual(["гостиница «Метрополь», Москва", "Метрополь, Москва"]);
  });

  it("gives no time to another building the map matched", async () => {
    // Live on 25.09 «Тверская улица 7» came back as «Тверская улица 12 с7».
    const fromOther = await measure({
      from: "Тверская улица 7, Москва",
      mode: "driving",
      to: ["метро Чистые пруды, Москва"],
    });

    expect(fromOther.status).toBe("not_found");
    expect(fromOther.note).toContain(
      "the map matched another building, «Тверская улица 12 с7, Москва»"
    );
    expect(requestsTo("routing.openstreetmap.de")).toEqual([]);

    const toOther = await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["Тверская улица 7, Москва", "Чистопрудный бульвар 12, Москва"],
    });
    expect(toOther.routes?.[0]?.error).toContain("another building");
    expect(toOther.routes?.[0]?.minutes).toBeUndefined();
    expect(toOther.routes?.[1]).toMatchObject({ minutes: 21 });
  });

  it("says the start is not on the map instead of measuring from somewhere else", async () => {
    const result = await measure({
      from: "мой отель",
      mode: "walking",
      to: ["метро Чистые пруды, Москва"],
    });

    expect(result.status).toBe("not_found");
    expect(result.note).toContain("мой отель");
    expect(requestsTo("routing.openstreetmap.de")).toEqual([]);
  });

  it("marks a destination it could not find and measures the rest", async () => {
    const result = await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["Несуществующее кафе", "метро Чистые пруды, Москва"],
    });

    expect(result.routes?.[0]?.error).toContain("not on the map");
    expect(result.routes?.[1]).toMatchObject({ km: 1.6, minutes: 21 });
  });

  it("gives only the straight-line distance when the router is down", async () => {
    fetchMock.mockImplementation(async (url) =>
      url.host === "nominatim.openstreetmap.org"
        ? geocoderAnswer(url)
        : new Response("busy", { status: 503 })
    );

    const result = await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["метро Чистые пруды, Москва"],
    });

    expect(result.status).toBe("ok");
    expect(result.routes?.[0]?.error).toContain("state no travel time");
    expect(result.routes?.[0]?.straightKm).toBe(1.3);
    expect(result.routes?.[0]?.minutes).toBeUndefined();
  });

  it("backs off once on a 429 and then leaves the host alone for a while", async () => {
    fetchMock.mockImplementation(async (url) => {
      requestTimes.push({ at: Date.now(), host: url.host });
      return new Response("slow down", { status: 429 });
    });

    const result = await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["метро Чистые пруды, Москва"],
    });

    expect(result).toMatchObject({ status: "unavailable" });
    expect(result.note).toContain("HTTP 429");
    expect(result.note).toContain("do not guess");
    // One retry, after at least the base pause.
    expect(requestTimes).toHaveLength(2);
    expect(
      (requestTimes[1]?.at ?? 0) - (requestTimes[0]?.at ?? 0)
    ).toBeGreaterThanOrEqual(1500);

    const again = await measure({
      from: "гостиница Националь, Москва",
      mode: "walking",
      to: ["метро Чистые пруды, Москва"],
    });
    expect(again.note).toContain("asked to slow down");
    expect(requestTimes).toHaveLength(2);
  });

  it("measures after one 429 when the retry succeeds", async () => {
    let refused = false;
    fetchMock.mockImplementation(async (url) => {
      if (url.host === "nominatim.openstreetmap.org" && !refused) {
        refused = true;
        return new Response("slow down", {
          headers: { "retry-after": "3" },
          status: 429,
        });
      }
      return url.host === "nominatim.openstreetmap.org"
        ? geocoderAnswer(url)
        : routerAnswer(url);
    });

    const result = await measure({
      from: "отель Метрополь, Москва",
      mode: "walking",
      to: ["метро Чистые пруды, Москва"],
    });

    expect(result.status).toBe("ok");
    expect(result.routes?.[0]?.minutes).toBe(21);
  });

  it("warns that a drive has no traffic and links the live route abroad on Google Maps", async () => {
    const result = await measure({
      from: "Times Square, New York",
      mode: "driving",
      to: ["Central Park, New York"],
    });

    expect(result.basis).toContain("without live traffic");
    expect(result.routes?.[0]?.link).toBe(
      "https://www.google.com/maps/dir/?api=1&origin=40.758000,-73.985500&destination=40.781200,-73.966500&travelmode=driving"
    );
    expect(requestsTo("routing.openstreetmap.de")[0]?.pathname).toMatch(
      /^\/routed-car\//u
    );
    // An English query gets English names back.
    expect(
      requestsTo("nominatim.openstreetmap.org").map((url) =>
        url.searchParams.get("accept-language")
      )
    ).toEqual(["en,ru", "en,ru"]);
  });
});

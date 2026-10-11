import { createContext, runInContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type JsonValue,
  operationAnswerSchema,
} from "@agent/lib/yandex/operations";
import type { runYandexOperation } from "@agent/lib/yandex/transport";
import quoteFixture from "@tests/fixtures/yandex/go-purchase/quote.json";
import completedFixture from "@tests/fixtures/yandex/go-purchase/completed.json";

const transport = vi.hoisted(() => ({
  run: vi.fn<typeof runYandexOperation>(),
}));
vi.mock("@agent/lib/yandex/transport", () => ({
  runYandexOperation: transport.run,
}));

import {
  commitGoPurchase,
  draftGoPurchase,
  prepareGoPurchase,
} from "@agent/lib/yandex/go/purchase";
import { readGoPurchaseStatus } from "@agent/lib/yandex/go/rides";

const userId = "0123456789abcdef0123456789abcdef";
const route: [[number, number], [number, number]] = [
  [10, 10],
  [10.1, 10.1],
];
const workspaceId = "workspace:synthetic";
const draftPath = "/external/3.0/orderdraft";
const commitPath = "/external/3.0/ordercommit";
const quotePath = "/3.0/routestats";
const statusPath = "/3.0/taxiontheway";
const requests: { path: string; body: JsonValue }[] = [];
const redirectModes: RequestInit["redirect"][] = [];
const headers: Headers[] = [];
const storage = new Map<string, string>();
let quote = structuredClone(quoteFixture);
let selected: JsonValue;
let methods: JsonValue;
let persistedUserId: string;

const serve = vi.fn<
  (
    path: string,
    body: JsonValue
  ) => {
    body: JsonValue;
    status?: number;
    headers?: HeadersInit;
  }
>();

function syntheticIndexedDb() {
  return {
    open() {
      const request = {
        onsuccess: vi.fn<() => void>(),
        result: {
          transaction: () => ({
            objectStore: () => ({
              get: (key: string) => {
                const read = {
                  onsuccess: vi.fn<() => void>(),
                  result:
                    key === "persist:session"
                      ? { userId: persistedUserId }
                      : { selectedPaymentMethod: selected },
                };
                queueMicrotask(() => {
                  read.onsuccess();
                });
                return read;
              },
            }),
          }),
        },
      };
      queueMicrotask(() => {
        request.onsuccess();
      });
      return request;
    },
  };
}

async function ready() {
  const prepared = await prepareGoPurchase(workspaceId, { route });
  if (prepared.kind !== "ready") throw new Error(prepared.reason);
  return prepared;
}

function economQuote() {
  const tariff = quote.service_levels[0];
  if (!tariff) throw new Error("Missing synthetic tariff");
  return tariff;
}

async function draft(prepared: Awaited<ReturnType<typeof ready>>) {
  return draftGoPurchase(workspaceId, {
    amountMinor: prepared.publicQuote.amountMinor,
    snapshot: prepared.snapshot,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  requests.length = 0;
  redirectModes.length = 0;
  headers.length = 0;
  storage.clear();
  quote = structuredClone(quoteFixture);
  persistedUserId = userId;
  selected = { id: "cash", type: "cash", zoneAvailable: true };
  methods = {
    card: {
      payment_available: true,
      available_cards: [],
      unverified_cards: [],
    },
  };
  serve.mockImplementation((path, body): ReturnType<typeof serve> => {
    if (path === "/csrf_token") return { body: { sk: "synthetic-csrf" } };
    if (path === quotePath) return { body: quote };
    if (path === "/3.0/paymentmethods") return { body: methods };
    if (path === "/4.0/persuggest/v1/finalsuggest") {
      const point = z
        .object({
          position: z.tuple([z.number(), z.number()]),
          type: z.string(),
        })
        .parse(body);
      return {
        body: {
          results: [
            {
              type: "address",
              position: point.position,
              text: `Synthetic ${point.type}`,
              title: { text: `Synthetic ${point.type}` },
              city: "Synthetic city",
              uri: `synthetic:${point.type}`,
            },
          ],
        },
      };
    }
    if (path === draftPath) return { body: { orderid: "synthetic-order" } };
    if (path === commitPath) return { body: { status: "search" } };
    if (path === statusPath) return { body: completedFixture };
    throw new Error("Unexpected synthetic request");
  });
  transport.run.mockImplementation(async (_workspace, operation, args) => {
    const context = createContext({
      Date,
      crypto: webcrypto,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      setTimeout: (callback: () => void) => {
        queueMicrotask(callback);
      },
      indexedDB: syntheticIndexedDb(),
      navigator: { userAgent: "Synthetic test" },
      fetch: async (url: string, input: RequestInit) => {
        const path = new URL(url).pathname;
        const body = z.json().parse(JSON.parse(z.string().parse(input.body)));
        requests.push({ path, body });
        redirectModes.push(input.redirect);
        headers.push(new Headers(input.headers));
        const result = serve(path, body);
        return {
          status: result.status ?? 200,
          headers: new Headers(result.headers),
          json: async () => result.body,
        };
      },
    });
    const run = z
      .function({ input: [z.json()], output: z.promise(z.json()) })
      .parse(runInContext(`(${operation.run})`, context));
    const answer = operationAnswerSchema.parse(
      JSON.parse(JSON.stringify(await run(args)))
    );
    if (answer.status !== "ok") return { kind: answer.status };
    return { kind: "ok", data: operation.result.parse(answer.data) };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Go fixed provider functions", () => {
  it.each(["network", "503"])(
    "recovers one transient %s during a read, never sending a booking",
    async (failure) => {
      storage.set(
        "csrf_token",
        JSON.stringify({ token: "synthetic", validUntil: Date.now() + 60_000 })
      );
      serve.mockImplementationOnce(() => {
        if (failure === "network") throw new TypeError("Failed to fetch");
        return { status: 503, body: {} };
      });
      await ready();
      expect(
        requests.filter(
          ({ path }) => path === "/4.0/persuggest/v1/finalsuggest"
        )
      ).toHaveLength(3);
      expect(
        requests.some(({ path }) => path === draftPath || path === commitPath)
      ).toBe(false);
    }
  );

  it("uses the native unexpired CSRF cache instead of another authentication request", async () => {
    storage.set(
      "csrf_token",
      JSON.stringify({
        token: "synthetic-cached-csrf",
        validUntil: Date.now() + 60_000,
      })
    );
    await ready();
    expect(requests.some(({ path }) => path === "/csrf_token")).toBe(false);
    expect(headers[0]?.get("x-csrf-token")).toBe("synthetic-cached-csrf");
    expect(headers[0]?.has("x-yataxi-tz-offset")).toBe(false);
    expect(headers[0]?.get("x-retpath-y")).toBe(
      "https://taxi.yandex.ru/captcha-success"
    );
    expect(headers[0]?.has("x-request-id")).toBe(true);
  });

  it.each([
    undefined,
    "{invalid",
    JSON.stringify({ token: "synthetic-expired", validUntil: 1 }),
    JSON.stringify({ token: 123, validUntil: 99_999_999_999_999 }),
  ])(
    "refreshes an unusable CSRF cache %s with the native safety margin",
    async (cached) => {
      if (cached !== undefined) storage.set("csrf_token", cached);
      serve.mockImplementationOnce(() => ({
        body: { sk: "synthetic-fresh", "max-age-seconds": 120 },
      }));
      const before = Date.now();
      await ready();
      const saved = z
        .object({ token: z.string(), validUntil: z.number() })
        .parse(JSON.parse(storage.get("csrf_token") ?? "null"));
      expect(saved.token).toBe("synthetic-fresh");
      expect(saved.validUntil).toBeGreaterThanOrEqual(before + 60_000);
      expect(saved.validUntil).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(headers[0]?.has("x-yataxi-userid")).toBe(false);
      expect(headers[0]?.has("x-csrf-token")).toBe(false);
      expect(headers[1]?.get("x-csrf-token")).toBe("synthetic-fresh");
      await ready();
      expect(
        requests.filter(({ path }) => path === "/csrf_token")
      ).toHaveLength(1);
    }
  );

  it.each([
    { status: 429, headers: {} },
    { status: 500, headers: { "x-yataxi-retry-action": "stop" } },
    { status: 503, headers: { "retry-after": "60" } },
    { status: 503, headers: { "x-yataxi-retry-interval-ms": "1000" } },
  ])(
    "does not retry reads after provider rate or retry instructions: $status $headers",
    async (response) => {
      storage.set(
        "csrf_token",
        JSON.stringify({ token: "synthetic", validUntil: Date.now() + 60_000 })
      );
      serve.mockImplementationOnce(() => ({ ...response, body: {} }));
      expect(await prepareGoPurchase(workspaceId, { route })).toEqual({
        kind: "blocked",
        reason: `http_${String(response.status)}`,
      });
      expect(requests).toHaveLength(1);
    }
  );

  it("rejects a failed session read before draft rather than claiming an unknown booking", async () => {
    const prepared = await ready();
    serve.mockImplementation(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await draft(prepared)).toEqual({
      kind: "rejected",
      reason: "read_failed",
    });
    expect(
      requests.some(({ path }) => path === draftPath || path === commitPath)
    ).toBe(false);
  });

  it("only reads during preparation and uses exact fare, not rounded display", async () => {
    const prepared = await ready();
    expect(prepared.publicQuote).toMatchObject({
      amountMinor: 135900,
      currency: "RUB",
      tariff: "econom",
      payment: "CASH",
      paymentLabel: "НАЛИЧНЫМИ (CASH)",
    });
    expect(prepared.publicQuote.route.map((point) => point.geopoint)).toEqual(
      route
    );
    expect(prepared.expiresAt).toBe(prepared.snapshot.expiresAt);
    expect(Date.parse(prepared.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 120000
    );
    expect(requests.map((request) => request.path)).toEqual([
      "/csrf_token",
      "/4.0/persuggest/v1/finalsuggest",
      "/4.0/persuggest/v1/finalsuggest",
      "/3.0/paymentmethods",
      quotePath,
    ]);
    expect(
      requests.some(
        (request) => request.path === draftPath || request.path === commitPath
      )
    ).toBe(false);
  });

  it.each(["1359.001", "1359,00", "1e3", "-1", "90071992547409.92"])(
    "rejects a nonexact or unsafe decimal %s before any draft",
    async (amount) => {
      economQuote().max_price_as_decimal = amount;
      expect(await prepareGoPurchase(workspaceId, { route })).toMatchObject({
        kind: "blocked",
        reason: "money_invalid",
      });
      expect(requests.some((request) => request.path === draftPath)).toBe(
        false
      );
    }
  );

  it("crosschecks both exact raw and args prices", async () => {
    economQuote().prices.raw.final_price = "1350";
    expect(await prepareGoPurchase(workspaceId, { route })).toMatchObject({
      kind: "blocked",
      reason: "money_inconsistent",
    });
    quote = structuredClone(quoteFixture);
    economQuote().prices.args.final_price = "1350";
    expect(await prepareGoPurchase(workspaceId, { route })).toMatchObject({
      kind: "blocked",
      reason: "money_inconsistent",
    });
  });

  it("refuses inconsistent offers, hidden/nonfixed tariffs and unsupported requirements", async () => {
    economQuote().offer = "different";
    expect(await prepareGoPurchase(workspaceId, { route })).toMatchObject({
      kind: "blocked",
      reason: "offer_inconsistent",
    });
    quote = structuredClone(quoteFixture);
    economQuote().is_hidden = true;
    expect(await prepareGoPurchase(workspaceId, { route })).toMatchObject({
      kind: "blocked",
      reason: "tariff_unsupported",
    });
    quote = structuredClone(quoteFixture);
    quote.is_fixed_price = false;
    expect(await prepareGoPurchase(workspaceId, { route })).toMatchObject({
      kind: "blocked",
      reason: "tariff_unsupported",
    });
    quote = structuredClone(quoteFixture);
    economQuote().tariff_requirements = { child_seat: true };
    expect(await prepareGoPurchase(workspaceId, { route })).toMatchObject({
      kind: "blocked",
      reason: "requirements_unsupported",
    });
  });

  it("rejects ambiguous or snapped route points before drafting", async () => {
    const normal = serve.getMockImplementation();
    serve.mockImplementation((path, body): ReturnType<typeof serve> =>
      path === "/4.0/persuggest/v1/finalsuggest"
        ? {
            body: {
              results: [
                {
                  type: "address",
                  position: [10.2, 10.2],
                  text: "Synthetic",
                  title: { text: "Synthetic" },
                },
              ],
            },
          }
        : (normal?.(path, body) ?? { body: {} })
    );
    expect(await prepareGoPurchase(workspaceId, { route })).toMatchObject({
      kind: "blocked",
      reason: "route_ambiguous",
    });
    expect(requests.some((request) => request.path === draftPath)).toBe(false);
  });

  it("sends route objects and a current matching fresh offer in one draft, then one exact commit", async () => {
    const prepared = await ready();
    quote.offer = "b".repeat(32);
    economQuote().offer = quote.offer;
    expect(await draft(prepared)).toEqual({
      kind: "drafted",
      orderId: "synthetic-order",
    });
    const sent = requests.filter((request) => request.path === draftPath);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      id: userId,
      class: ["econom"],
      payment: { type: "cash", payment_method_id: "cash" },
      offer: quote.offer,
      route: prepared.publicQuote.route,
      requirements: {},
    });
    expect(
      await commitGoPurchase(workspaceId, {
        orderId: "synthetic-order",
        snapshot: prepared.snapshot,
      })
    ).toEqual({ kind: "active", orderId: "synthetic-order" });
    expect(requests.filter((request) => request.path === commitPath)).toEqual([
      { path: commitPath, body: { id: userId, orderid: "synthetic-order" } },
    ]);
    expect(redirectModes).toEqual(requests.map(() => "error"));
  });

  it("compares exact fresh fare and payment before draft, and expires locally", async () => {
    const prepared = await ready();
    economQuote().max_price_as_decimal = "1360.00";
    economQuote().prices.raw.final_price = "1360";
    economQuote().prices.args.final_price = "1360";
    expect(await draft(prepared)).toMatchObject({
      kind: "rejected",
      reason: "quote_changed",
    });
    expect(
      await draftGoPurchase(workspaceId, {
        amountMinor: prepared.publicQuote.amountMinor,
        snapshot: {
          ...prepared.snapshot,
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
      })
    ).toMatchObject({ kind: "rejected", reason: "quote_expired" });
    quote = structuredClone(quoteFixture);
    selected = { id: "another-cash", type: "cash", zoneAvailable: true };
    expect(await draft(prepared)).toMatchObject({
      kind: "rejected",
      reason: "quote_changed",
    });
    expect(requests.some((request) => request.path === draftPath)).toBe(false);
  });

  it.each([202, 400, 401, 429, 500])(
    "does not retry draft or commit HTTP %s and retains unknown",
    async (status) => {
      const prepared = await ready();
      const normal = serve.getMockImplementation();
      serve.mockImplementation((path, body): ReturnType<typeof serve> =>
        path === draftPath || path === commitPath
          ? { status, body: {} }
          : (normal?.(path, body) ?? { body: {} })
      );
      expect(await draft(prepared)).toEqual({ kind: "unknown" });
      expect(
        await commitGoPurchase(workspaceId, {
          orderId: "synthetic-order",
          snapshot: prepared.snapshot,
        })
      ).toEqual({ kind: "unknown" });
      expect(
        requests.filter((request) => request.path === draftPath)
      ).toHaveLength(1);
      expect(
        requests.filter((request) => request.path === commitPath)
      ).toHaveLength(1);
    }
  );

  it("does not mistake a raw data envelope or payment challenge for the proved client expectation", async () => {
    const prepared = await ready();
    const normal = serve.getMockImplementation();
    serve.mockImplementation((path, body): ReturnType<typeof serve> =>
      path === draftPath
        ? { body: { data: { orderid: "synthetic-order" } } }
        : path === commitPath
          ? { body: { status: "need_3ds", url: "https://example.invalid/" } }
          : (normal?.(path, body) ?? { body: {} })
    );
    expect(await draft(prepared)).toEqual({ kind: "unknown" });
    expect(
      await commitGoPurchase(workspaceId, {
        orderId: "synthetic-order",
        snapshot: prepared.snapshot,
      })
    ).toEqual({ kind: "unknown" });
  });

  it("preserves a verified currently selected saved card and exposes only its masked label", async () => {
    selected = { id: "synthetic-card", type: "card", zoneAvailable: true };
    methods = {
      card: {
        payment_available: true,
        available_cards: [
          { id: "synthetic-card", system: "VISA", number: "****1234" },
        ],
        unverified_cards: [],
      },
    };
    const prepared = await ready();
    expect(prepared.publicQuote).toMatchObject({
      payment: "SAVED_CARD",
      paymentLabel: "VISA •••• 1234",
    });
    expect(JSON.stringify(prepared.publicQuote)).not.toContain(
      "synthetic-card"
    );
    expect(await draft(prepared)).toMatchObject({ kind: "drafted" });
    expect(
      requests
        .filter((request) => request.path === quotePath)
        .every(
          (request) =>
            z
              .object({
                payment: z.object({
                  type: z.literal("card"),
                  payment_method_id: z.literal("synthetic-card"),
                }),
              })
              .safeParse(request.body).success
        )
    ).toBe(true);
    expect(
      requests.find((request) => request.path === draftPath)?.body
    ).toMatchObject({
      payment: { type: "card", payment_method_id: "synthetic-card" },
    });
  });

  it.each([
    { id: "synthetic-unverified", type: "card", zoneAvailable: true },
    { id: "synthetic-new", type: "card", zoneAvailable: true },
    {
      id: "synthetic-bank",
      type: "card",
      zoneAvailable: true,
      isYandexCard: true,
    },
    { id: "synthetic-credit", type: "credit", zoneAvailable: true },
    { id: "cash", type: "cash", zoneAvailable: false },
  ])(
    "rejects unsupported or unverified payment selection $id",
    async (selection) => {
      selected = z.json().parse(selection);
      methods = {
        card: {
          payment_available: true,
          available_cards: [],
          unverified_cards: [{ id: "synthetic-unverified" }],
        },
      };
      expect(await prepareGoPurchase(workspaceId, { route })).toMatchObject({
        kind: "blocked",
        reason: "payment_unsupported",
      });
      expect(requests.some((request) => request.path === draftPath)).toBe(
        false
      );
    }
  );

  it("does not commit after account or payment selection changes, even with a known draft", async () => {
    const prepared = await ready();
    selected = { id: "another-cash", type: "cash", zoneAvailable: true };
    expect(
      await commitGoPurchase(workspaceId, {
        orderId: "synthetic-order",
        snapshot: prepared.snapshot,
      })
    ).toEqual({ kind: "unknown" });
    selected = { id: "cash", type: "cash", zoneAvailable: true };
    persistedUserId = "f".repeat(32);
    expect(
      await commitGoPurchase(workspaceId, {
        orderId: "synthetic-order",
        snapshot: prepared.snapshot,
      })
    ).toEqual({ kind: "unknown" });
    expect(requests.some((request) => request.path === commitPath)).toBe(false);
  });

  it("reads only the requested known order, never sends break, and never declares cash paid", async () => {
    expect(
      await readGoPurchaseStatus(workspaceId, {
        orderId: "synthetic-order",
        providerUserId: userId,
      })
    ).toEqual({
      kind: "read",
      orderId: "synthetic-order",
      rideStatus: "complete",
      finalFareMinor: 10000,
      financialStatus: "unknown",
      cashLiabilityKnown: true,
    });
    expect(requests.filter((request) => request.path === statusPath)).toEqual([
      {
        path: statusPath,
        body: {
          orderid: "synthetic-order",
          format_currency: true,
          id: userId,
          show_text: true,
        },
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain('"break"');
    const normal = serve.getMockImplementation();
    serve.mockImplementation((path, body): ReturnType<typeof serve> =>
      path === statusPath
        ? { body: { status: "cancelled" } }
        : (normal?.(path, body) ?? { body: {} })
    );
    expect(
      await readGoPurchaseStatus(workspaceId, {
        orderId: "synthetic-order",
        providerUserId: userId,
      })
    ).toMatchObject({
      rideStatus: "cancelled",
      financialStatus: "unknown",
      finalFareMinor: null,
    });
  });

  it("reports expired authentication before an absent local payment selection", async () => {
    selected = null;
    const normal = serve.getMockImplementation();
    serve.mockImplementation((path, body): ReturnType<typeof serve> =>
      path === "/3.0/paymentmethods"
        ? { status: 401, body: {} }
        : (normal?.(path, body) ?? { body: {} })
    );
    expect(await prepareGoPurchase(workspaceId, { route })).toEqual({
      kind: "blocked",
      reason: "signed_out",
    });
    expect(
      requests.some(
        (request) => request.path === draftPath || request.path === commitPath
      )
    ).toBe(false);
  });
});

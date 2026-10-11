import { webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type JsonValue,
  operationAnswerSchema,
} from "@agent/lib/yandex/operations";
import type { runYandexOperation } from "@agent/lib/yandex/transport";
import cartFixture from "@tests/fixtures/yandex/lavka-purchase/cart.json";
import layoutFixture from "@tests/fixtures/yandex/lavka-purchase/layout.json";
import methodsFixture from "@tests/fixtures/yandex/lavka-purchase/methods.json";
import pageFixture from "@tests/fixtures/yandex/lavka-purchase/page.json";

const transport = vi.hoisted(() => ({
  run: vi.fn<typeof runYandexOperation>(),
}));
vi.mock("@agent/lib/yandex/transport", () => ({
  runYandexOperation: transport.run,
}));

import {
  prepareLavkaPurchase,
  submitLavkaPurchase,
} from "@agent/lib/yandex/lavka/checkout";

const cartPath = "/api/v1/providers/cart/v1/retrieve";
const layoutPath = "/api/v1/providers/orders/v1/checkout-layout";
const methodsPath = "/api/v1/providers/payments/v1/methods";
const submitPath = "/api/v1/orders/submit";
const { __PAGE_PROPS__: pageProps, __REACT_QUERY_STATE__: queryState } =
  pageFixture;
const startupFixture = queryState.queries.find(
  (entry) => entry.queryKey[0] === "CommonStartup"
);
if (!startupFixture) throw new Error("startup fixture missing");
const fixtureAddress = queryState.queries.find(
  (entry) => entry.queryKey[0] === "FavoriteAddresses"
)?.state.data;
if (!Array.isArray(fixtureAddress))
  throw new Error("saved address fixture missing");

const requests: { path: string; body: JsonValue }[] = [];
let cart: JsonValue;
let methods: JsonValue;
let layout: JsonValue;
let globals = structuredClone(pageFixture);
let saved = structuredClone(fixtureAddress);
const submitResponse = vi.fn<() => JsonValue>();
const delayElapsed = vi.fn<(milliseconds: number) => void>();
const serve = vi.fn<(path: string) => ReturnType<typeof response>>();

function response(
  body: JsonValue,
  status = 200,
  contentType = "application/json"
) {
  return { body, contentType, status };
}

async function ready() {
  const prepared = await prepareLavkaPurchase("workspace:synthetic");
  expect(prepared.kind).toBe("ready");
  if (prepared.kind !== "ready") throw new Error(prepared.reason);
  return prepared;
}

async function confirm(prepared: Awaited<ReturnType<typeof ready>>) {
  return submitLavkaPurchase("workspace:synthetic", {
    amountMinor: prepared.publicQuote.amountMinor,
    snapshot: prepared.snapshot,
  });
}

function withCart(change: Record<string, JsonValue>) {
  cart = { ...cartFixture, ...change };
}

beforeEach(() => {
  vi.resetAllMocks();
  requests.length = 0;
  cart = structuredClone(cartFixture);
  methods = structuredClone(methodsFixture);
  layout = structuredClone(layoutFixture);
  saved = structuredClone(fixtureAddress);
  globals = {
    __PAGE_PROPS__: structuredClone(pageProps),
    __REACT_QUERY_STATE__: {
      queries: [
        structuredClone(startupFixture),
        { queryKey: ["FavoriteAddresses"], state: { data: saved } },
      ],
    },
  };
  submitResponse.mockReturnValue({ orderId: "synthetic-order" });
  serve.mockImplementation((path) => {
    if (path === cartPath) return response(cart);
    if (path === layoutPath) return response(layout);
    if (path === methodsPath) return response(methods);
    if (path === submitPath) return response(submitResponse());
    throw new Error("unexpected route");
  });
  transport.run.mockImplementation(async (_workspace, operation, args) => {
    const context = createContext({
      AbortSignal,
      Date,
      TextEncoder,
      crypto: webcrypto,
      fetch: async (path: string, init: { body: string }) => {
        requests.push({ body: z.json().parse(JSON.parse(init.body)), path });
        const result = serve(path);
        return {
          headers: {
            get: (name: string) =>
              name === "content-type" ? result.contentType : null,
          },
          json: async () => result.body,
          status: result.status,
        };
      },
      setTimeout: (done: () => void, milliseconds: number) => {
        delayElapsed(milliseconds);
        done();
        return 0;
      },
      window: globals,
    });
    const run = z
      .function({ input: [z.json()], output: z.promise(z.json()) })
      .parse(runInContext(`(${operation.run})`, context));
    const answer = operationAnswerSchema.parse(
      JSON.parse(JSON.stringify(await run(args)))
    );
    if (answer.status === "signed_out" || answer.status === "captcha")
      return { kind: answer.status };
    return { data: operation.result.parse(answer.data), kind: "ok" };
  });
});

describe("Lavka purchase fixed page functions", () => {
  it("does not submit a quote that expired during the final request delay", async () => {
    const prepared = await ready();
    let clock = Date.parse(prepared.snapshot.expiresAt) - 4500;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    delayElapsed.mockImplementation((milliseconds) => {
      clock += milliseconds;
    });
    try {
      expect(await confirm(prepared)).toEqual({
        kind: "rejected",
        reason: "quote_expired",
      });
      expect(
        requests.filter((request) => request.path === submitPath)
      ).toHaveLength(0);
    } finally {
      now.mockRestore();
    }
  });
  it("prepares the observed 55 + 329 quote with the matching existing default card", async () => {
    const prepared = await ready();
    expect(prepared.publicQuote).toEqual({
      amountMinor: 38_400,
      currency: "RUB",
      delivery: "Москва, Тестовая улица, 1, кв. 1",
      items: [{ quantity: "1", title: "Вода без газа" }],
      payment: "Карта по умолчанию VISA",
    });
    expect(prepared.snapshot.payment.id).toBe("synthetic-card");
    expect(requests.map((request) => request.path)).toEqual([
      cartPath,
      layoutPath,
      methodsPath,
    ]);
    expect(requests[2]?.body).toEqual({
      countryIso3: "RUS",
      location: [37.6208, 55.7539],
      depotType: "regular",
      cartId: "synthetic-cart",
    });
    expect(JSON.stringify(prepared.snapshot)).not.toMatch(
      /csrf|token|number|cardBank|doorcode|flat/iu
    );
    expect(Date.parse(prepared.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 120_000
    );
    expect(transport.run.mock.calls[0]?.[1].access).toBe("read");
  });

  it("keeps exact decimal money without floating-point multiplication", async () => {
    withCart({
      totalPriceValue: "384.57",
      totalItemsPrice: "55.07",
      orderConditions: { deliveryCost: "329.50" },
      items: [{ ...cartFixture.items[0], price: "55.07" }],
    });
    expect((await ready()).publicQuote.amountMinor).toBe(38_457);
  });

  it.each(["55.001", "1e2", "NaN", "-1", "55,50", "9007199254740991"])(
    "blocks invalid money %s",
    async (price) => {
      withCart({ totalPriceValue: price });
      expect(await prepareLavkaPurchase("workspace:synthetic")).toEqual({
        kind: "blocked",
        reason: "money_invalid",
      });
    }
  );

  it("blocks totals that do not equal the exact supported components", async () => {
    withCart({ totalPriceValue: "385" });
    expect(await prepareLavkaPurchase("workspace:synthetic")).toEqual({
      kind: "blocked",
      reason: "money_inconsistent",
    });
  });

  it("blocks an empty cart before asking about payment", async () => {
    withCart({ items: [] });
    expect(await prepareLavkaPurchase("workspace:synthetic")).toEqual({
      kind: "blocked",
      reason: "empty_cart",
    });
    expect(requests).toHaveLength(1);
  });

  it("blocks a missing existing default card", async () => {
    methods = { methods: [], flow: "default" };
    expect(await prepareLavkaPurchase("workspace:synthetic")).toEqual({
      kind: "blocked",
      reason: "payment_unverified",
    });
  });

  it.each(["cash", "split", "credit", "corp"])(
    "blocks unsupported payment %s",
    async (type) => {
      methods = {
        ...methodsFixture,
        defaultMethod: { ...methodsFixture.defaultMethod, type },
      };
      expect(await prepareLavkaPurchase("workspace:synthetic")).toEqual({
        kind: "blocked",
        reason: "payment_unsupported",
      });
    }
  );

  it("requires the default card to match the available saved method", async () => {
    methods = {
      ...methodsFixture,
      methods: [{ ...methodsFixture.defaultMethod, system: "MIR" }],
    };
    expect(await prepareLavkaPurchase("workspace:synthetic")).toEqual({
      kind: "blocked",
      reason: "payment_unverified",
    });
  });

  it("shows only a safely masked card suffix in the confirmation", async () => {
    const method = {
      ...methodsFixture.defaultMethod,
      number: "**** **** **** 1234",
    };
    methods = { ...methodsFixture, defaultMethod: method, methods: [method] };
    const prepared = await ready();
    expect(prepared.publicQuote.payment).toBe(
      "Сохранённая карта VISA •••• 1234"
    );
    expect(prepared.snapshot.payment.last4).toBe("1234");
    expect(JSON.stringify(prepared)).not.toContain("**** ****");
  });

  it("does not expose a full card number even if an API sends one", async () => {
    const method = {
      ...methodsFixture.defaultMethod,
      number: "4111111111111111",
    };
    methods = { ...methodsFixture, defaultMethod: method, methods: [method] };
    const prepared = await ready();
    expect(prepared.snapshot.payment.last4).toBeNull();
    expect(JSON.stringify(prepared)).not.toContain(method.number);
  });

  it("blocks apartments sharing the same coordinates instead of choosing the first", async () => {
    const duplicate = structuredClone(saved[0]);
    if (!duplicate) throw new Error("fixture missing");
    duplicate.address.flat = "2";
    saved.push(duplicate);
    expect(await prepareLavkaPurchase("workspace:synthetic")).toEqual({
      kind: "blocked",
      reason: "address_ambiguous",
    });
    expect(requests).toHaveLength(0);
  });

  it("refuses a cart payment that differs from the fresh-page default", async () => {
    withCart({ paymentMethod: { id: "another-card", type: "card" } });
    expect(await prepareLavkaPurchase("workspace:synthetic")).toEqual({
      kind: "blocked",
      reason: "payment_unverified",
    });
  });

  it.each<Record<string, JsonValue>>([
    { subscription: { enabled: true } },
    { orderFlowVersion: "tristero_flow_v1" },
    { cashback: { flow: "charge" } },
    { timeslot: { start: "later" } },
  ])("blocks unsupported financial flows", async (change) => {
    withCart(change);
    expect((await prepareLavkaPurchase("workspace:synthetic")).kind).toBe(
      "blocked"
    );
  });

  it("does not mistake cashback payment eligibility for an active cashback flow", async () => {
    withCart({
      cashback: { exist: true, fullPayment: true, fullPaymentCharge: false },
    });
    expect((await ready()).publicQuote.amountMinor).toBe(38_400);
  });

  it("blocks weighted or restricted goods", async () => {
    withCart({ items: [{ ...cartFixture.items[0], quantityType: "weight" }] });
    expect(await prepareLavkaPurchase("workspace:synthetic")).toEqual({
      kind: "blocked",
      reason: "item_unsupported",
    });
  });

  it("submits once with the fresh address and existing card id, never reporting paid from orderId", async () => {
    const prepared = await ready();
    requests.length = 0;
    expect(await confirm(prepared)).toEqual({
      kind: "placed",
      orderId: "synthetic-order",
      paymentStatus: "unknown",
    });
    expect(requests.map((request) => request.path)).toEqual([
      cartPath,
      layoutPath,
      methodsPath,
      cartPath,
      submitPath,
    ]);
    expect(requests.at(-1)?.body).toMatchObject({
      cartId: "synthetic-cart",
      cartVersion: 2,
      flowVersion: "grocery_flow_v1",
      paymentMethodId: "synthetic-card",
      paymentMethodType: "card",
      useRover: false,
    });
    expect(transport.run.mock.calls.at(-1)?.[1].access).toBe("purchase");
    expect(submitResponse).toHaveBeenCalledTimes(1);
  });

  it("reads the live submit envelope without treating the order as paid", async () => {
    const prepared = await ready();
    submitResponse.mockReturnValue({
      data: { orderId: "synthetic-wrapped-order" },
    });
    expect(await confirm(prepared)).toEqual({
      kind: "placed",
      orderId: "synthetic-wrapped-order",
      paymentStatus: "unknown",
    });
    expect(submitResponse).toHaveBeenCalledTimes(1);
    expect(
      requests.filter((request) => request.path === submitPath)
    ).toHaveLength(1);
  });

  it.each<JsonValue>([{}, { orderId: "" }, { orderId: null }, { orderId: 42 }])(
    "keeps an invalid wrapped order id unknown without retries: %j",
    async (data) => {
      const prepared = await ready();
      submitResponse.mockReturnValue({ data });
      expect(await confirm(prepared)).toEqual({ kind: "unknown" });
      expect(submitResponse).toHaveBeenCalledTimes(1);
      expect(
        requests.filter((request) => request.path === submitPath)
      ).toHaveLength(1);
    }
  );

  it("rejects changed exact prices without posting an order", async () => {
    const prepared = await ready();
    withCart({
      totalPriceValue: "385",
      totalItemsPrice: "56",
      items: [{ ...cartFixture.items[0], price: "56" }],
    });
    expect(await confirm(prepared)).toEqual({
      kind: "rejected",
      reason: "amount_changed",
    });
    expect(submitResponse).not.toHaveBeenCalled();
  });

  it.each<Record<string, JsonValue>>([
    { cartVersion: 3 },
    { offerId: "different-offer" },
    { deliveryConditionsId: "different-conditions" },
    { validUntil: "2099-10-14T00:00:00Z" },
  ])("rejects changed snapshot identity before submit", async (change) => {
    const prepared = await ready();
    withCart(change);
    expect(await confirm(prepared)).toEqual({
      kind: "rejected",
      reason: "checkout_changed",
    });
    expect(submitResponse).not.toHaveBeenCalled();
  });

  it("rejects an address edit even without an address-version increment", async () => {
    const prepared = await ready();
    const address = saved[0]?.address;
    if (!address) throw new Error("fixture missing");
    address.flat = "2";
    expect(await confirm(prepared)).toEqual({
      kind: "rejected",
      reason: "address_changed",
    });
    expect(submitResponse).not.toHaveBeenCalled();
  });

  it("rejects a changed existing card", async () => {
    const prepared = await ready();
    const changed = {
      ...methodsFixture.defaultMethod,
      id: "another-saved-card",
    };
    methods = { ...methodsFixture, defaultMethod: changed, methods: [changed] };
    expect(await confirm(prepared)).toEqual({
      kind: "rejected",
      reason: "payment_changed",
    });
    expect(submitResponse).not.toHaveBeenCalled();
  });

  it("checks the cart again after reading payment", async () => {
    const prepared = await ready();
    let reads = 0;
    serve.mockImplementation((path) => {
      if (path === cartPath)
        return response(
          ++reads === 1 ? cart : { ...cartFixture, cartVersion: 3 }
        );
      if (path === layoutPath) return response(layout);
      if (path === methodsPath) return response(methods);
      return response(submitResponse());
    });
    expect(await confirm(prepared)).toEqual({
      kind: "rejected",
      reason: "checkout_changed",
    });
    expect(submitResponse).not.toHaveBeenCalled();
  });

  it("rejects a primitive or altered amount without opening a page", async () => {
    expect(
      await submitLavkaPurchase("workspace:synthetic", {
        snapshot: "not a snapshot",
        amountMinor: 100,
      })
    ).toEqual({ kind: "rejected", reason: "snapshot_invalid" });
    expect(transport.run).not.toHaveBeenCalled();
    const prepared = await ready();
    expect(
      await submitLavkaPurchase("workspace:synthetic", {
        snapshot: prepared.snapshot,
        amountMinor: 1,
      })
    ).toEqual({ kind: "rejected", reason: "amount_changed" });
    expect(submitResponse).not.toHaveBeenCalled();
  });

  it("rejects expired consent", async () => {
    const prepared = await ready();
    prepared.snapshot.expiresAt = "2000-01-01T00:00:00Z";
    expect(await confirm(prepared)).toEqual({
      kind: "rejected",
      reason: "quote_expired",
    });
    expect(submitResponse).not.toHaveBeenCalled();
  });

  it.each([
    [401, "application/json", "signed_out"],
    [403, "text/html", "captcha"],
  ] as const)(
    "handles a pre-submit wall %s",
    async (status, contentType, reason) => {
      const prepared = await ready();
      serve.mockReturnValue(response({}, status, contentType));
      expect(await prepareLavkaPurchase("workspace:synthetic")).toEqual({
        kind: "blocked",
        reason,
      });
      expect(await confirm(prepared)).toEqual({ kind: "rejected", reason });
      expect(submitResponse).not.toHaveBeenCalled();
    }
  );

  it("keeps an accepted submit with a lost response unknown and never retries", async () => {
    const prepared = await ready();
    submitResponse.mockImplementation(() => {
      throw new Error("timeout after acceptance");
    });
    expect(await confirm(prepared)).toEqual({ kind: "unknown" });
    expect(submitResponse).toHaveBeenCalledTimes(1);
    expect(
      requests.filter((request) => request.path === submitPath)
    ).toHaveLength(1);
  });

  it.each([401, 409, 500])(
    "keeps an ambiguous post-submit HTTP %s unknown without retries",
    async (status) => {
      const prepared = await ready();
      serve.mockImplementation((path) =>
        path === submitPath
          ? response({}, status)
          : response(
              path === cartPath ? cart : path === layoutPath ? layout : methods
            )
      );
      expect(await confirm(prepared)).toEqual({ kind: "unknown" });
      expect(
        requests.filter((request) => request.path === submitPath)
      ).toHaveLength(1);
    }
  );

  it("keeps an unexpected successful submit response unknown", async () => {
    const prepared = await ready();
    submitResponse.mockReturnValue({ success: true });
    expect(await confirm(prepared)).toEqual({ kind: "unknown" });
    expect(submitResponse).toHaveBeenCalledTimes(1);
  });
});

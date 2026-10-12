import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@agent/lib/yandex/operations";
import type { runYandexOperation } from "@agent/lib/yandex/transport";
import { type FakeResponse, runInPage } from "./page";

const transport = vi.hoisted(() => ({
  run: vi.fn<typeof runYandexOperation>(),
}));
vi.mock("@agent/lib/yandex/transport", () => ({
  runYandexOperation: transport.run,
}));

import {
  prepareEdaPurchase,
  submitEdaPurchase,
} from "@agent/lib/yandex/eda/checkout";

const target = { lat: 55.69551, lon: 37.48573, place: "karavaevy" };

const cart = (price = 170, line = 1) => ({
  cart: {
    decimal_total: String(price + 328),
    items: [
      {
        id: line,
        item_id: 3004826043,
        name: "Блин с курицей ",
        price,
        quantity: 1,
      },
    ],
  },
});

const home = {
  city: "Москва",
  full_text: "Россия, Москва, Мичуринский проспект, 56",
  house: "56",
  id: "home-address",
  location: { latitude: 55.69551, longitude: 37.48573 },
  office: "371",
  short_text: "Мичуринский проспект, 56",
  street: "Мичуринский проспект",
  version: 81,
};

const offer = (id: string, cost: string) => ({
  availability: { available: true },
  mappingType: "base",
  possiblePayment: {
    availability: { available: true },
    costForCustomer: { value: cost },
    id,
    title: "VISA •• 4310",
  },
  requestId: `checkout.${id}`,
});

const requests: { body: JsonValue; method: string; path: string }[] = [];
let answers: Map<string, FakeResponse | FakeResponse[]>;

const sent = (path: string) => requests.filter((r) => r.path === path);

beforeEach(() => {
  requests.length = 0;
  answers = new Map<string, FakeResponse | FakeResponse[]>([
    ["/eats/v1/cart/v2/full-carts", { body: cart() }],
    ["/api/v3/user/addresses", { body: [home] }],
    [
      "/api/v2/cart/go-checkout",
      {
        body: {
          meta: { phone: "+70000000000" },
          offers: [offer("sbp_qr", "498.00"), offer("card-x1", "498.00")],
        },
      },
    ],
    ["/api/v1/orders", { body: { order_nr: "261012-1" } }],
    [
      "/eats/v1/eats-payments/v1/order/tracking",
      {
        body: {
          order: {
            payment: {
              payload: { url: "https://trust.yandex.ru/web/challenge?x=1" },
              status: "3ds_required",
            },
          },
        },
      },
    ],
  ]);
  transport.run.mockImplementation(async (_workspace, operation, args) => {
    const answer = await runInPage(operation.run, z.json().parse(args), {
      origin: "https://eda.yandex.ru/",
      respond(url, init) {
        requests.push({
          body: z.json().parse(JSON.parse(init.body ?? "null")),
          method: init.method ?? "GET",
          path: url.pathname,
        });
        const fake = answers.get(url.pathname);
        if (Array.isArray(fake))
          return fake.shift() ?? { body: {}, status: 500 };
        return fake ?? { body: {}, status: 404 };
      },
    });
    if (answer.status !== "ok") return { kind: answer.status };
    return { data: answer.data, kind: "ok" };
  });
});

async function ready() {
  const prepared = await prepareEdaPurchase("workspace:synthetic", target);
  if (prepared.kind !== "ready") throw new Error(prepared.reason);
  return prepared;
}

describe("Eda purchase", () => {
  it("reads the restaurant cart as one exact quote to the saved address with the card Eda offers", async () => {
    const prepared = await ready();
    expect(prepared.publicQuote).toEqual({
      amountMinor: 49800,
      currency: "RUB",
      delivery: "Мичуринский проспект, 56, кв. 371",
      items: [{ quantity: "1", title: "Блин с курицей" }],
      payment: "Карта VISA •• 4310",
    });
    expect(prepared.snapshot).toMatchObject({
      addressId: "home-address",
      cardId: "card-x1",
      items: [
        { id: 3004826043, positionId: 1, priceMinor: 17000, quantity: 1 },
      ],
    });
    expect(sent("/api/v1/orders")).toHaveLength(0);
  });

  it("quotes the same dish in a new cart as a new purchase, not the one already placed", async () => {
    const first = await ready();
    answers.set("/eats/v1/cart/v2/full-carts", { body: cart(170, 2) });
    const again = await ready();
    expect(again.publicQuote).toEqual(first.publicQuote);
    expect(again.snapshot.items[0]?.positionId).toBe(2);
    expect(again.snapshot).not.toEqual(first.snapshot);
  });

  it("does not quote an address the person has not saved", async () => {
    answers.set("/api/v3/user/addresses", { body: [] });
    expect(await prepareEdaPurchase("workspace:synthetic", target)).toEqual({
      kind: "blocked",
      reason: "saved_address_required",
    });
  });

  it("orders once with the offer it has just read and returns the bank's form", async () => {
    const prepared = await ready();
    requests.length = 0;
    expect(
      await submitEdaPurchase("workspace:synthetic", {
        amountMinor: prepared.publicQuote.amountMinor,
        snapshot: prepared.snapshot,
      })
    ).toEqual({
      confirmUrl: "https://trust.yandex.ru/web/challenge?x=1",
      kind: "placed",
      orderId: "261012-1",
      paymentStatus: "needs_confirmation",
    });
    expect(sent("/api/v1/orders")).toHaveLength(1);
    expect(sent("/api/v1/orders")[0]?.body).toMatchObject({
      paymentMethodId: "card-x1",
      place_slug: "karavaevy",
      request_id: "checkout.card-x1",
      userAddressId: "home-address",
    });
  });

  it("orders nothing when the cart changed since the person's yes", async () => {
    const prepared = await ready();
    answers.set("/eats/v1/cart/v2/full-carts", { body: cart(180) });
    expect(
      await submitEdaPurchase("workspace:synthetic", {
        amountMinor: prepared.publicQuote.amountMinor,
        snapshot: prepared.snapshot,
      })
    ).toMatchObject({ kind: "rejected" });
    expect(sent("/api/v1/orders")).toHaveLength(0);
  });

  it("takes Eda's own refusal as nothing ordered, and a failure after sending as unknown", async () => {
    const prepared = await ready();
    const submit = async () =>
      submitEdaPurchase("workspace:synthetic", {
        amountMinor: prepared.publicQuote.amountMinor,
        snapshot: prepared.snapshot,
      });
    answers.set("/api/v1/orders", { body: { code: 59 }, status: 400 });
    expect(await submit()).toEqual({ kind: "rejected", reason: "eda_59" });
    answers.set("/api/v1/orders", { body: {}, status: 500 });
    expect(await submit()).toEqual({ kind: "unknown" });
  });
});

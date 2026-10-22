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
  afishaTarget,
  prepareAfishaPurchase,
  readAfishaPayment,
  submitAfishaPurchase,
} from "@agent/lib/yandex/afisha/checkout";

const key = "MzIzNDJ8ODI5ODU1fDE0MDQ3NjE4fDE3OTUxOTQwMDAwMDA=";
const link = `https://widget.afisha.yandex.ru/w/sessions/${key}?widgetName=w1`;
const target = { count: 2, link, zone: "VIP-входной (свободная рассадка)" };
const clientKey = "f6dc63f9-18ab-471b-89ff-eb9773910840";
const planUrl = "https://cdn1.svc.cdn.yandex.net/hallplans/abc";
const orderId = "1792665431815@fac1927e-8a09-4496-b156-0c0cc02d4d5b";
const orderPath = `/api/tickets/v2/orders/${encodeURIComponent(orderId)}`;
const form = "https://trust.yandex.ru/web/payment?purchase_token=payment_x";

/** The widget page renders its tokens into `__config`, on one line. */
const html = `<html><script>window['__config'] = {"clientKey":{"id":"${clientKey}","domains":["ya.ru"]},"fetch":{"defaultHeaders":{"X-Request-Id":"1792-1","X-CSRF-Token":"abc123:1792","X-Yandex-Uid":"371"}}};</script></html>`;

const rub = (value: number) => ({ currencyCode: "rub", value });
const price = (kopecks: number) => ({
  fee: rub(kopecks / 10),
  price: rub(kopecks),
  total: rub(kopecks + kopecks / 10),
});

const admission = {
  admission: true,
  availableSeatCount: 39,
  categories: [{ id: 1462978627, name: "ВИП-входной (без места)" }],
  id: 8,
  name: "VIP-входной (свободная рассадка)",
  seats: [
    {
      admission: true,
      categoryId: 1462978627,
      extSessionId: 369890754,
      levelId: 8,
      originalPrice: price(420000),
      priceInfo: price(420000),
      seat: { linkedSeats: [], xCoord: 979, yCoord: 231 },
      sourceCategoryId: "6a748722b63e787c576154bb",
      sourceLevelId: "6a745cc23a92c9190435c3b0",
    },
  ],
};

const plan = {
  result: {
    hallplan: {
      categories: [
        {
          categoryType: "regular",
          id: 1462978627,
          name: "ВИП-входной (без места)",
        },
      ],
      levels: [
        admission,
        { admission: false, categories: [], id: 2, name: "VIP Lounge" },
      ],
      maxTicketsCount: 6,
    },
  },
  status: "success",
};

const session = {
  result: {
    session: {
      enabledSeatLock: false,
      enabledSmartCaptcha: false,
      event: {
        eventSaleAgreementRequirements: [],
        eventSalePersonalDataRequirements: [
          { eventSalePersonalDataType: "fullname" },
          { eventSalePersonalDataType: "email" },
          { eventSalePersonalDataType: "phone-number" },
        ],
        eventSalePersonalTicketDataRequirements: [],
        name: "Свидание",
      },
      hasPresale: false,
      maxTicketsCount: 6,
      needPlus: false,
      saleStatus: "available",
      sessionAuthRequired: false,
      sessionDate: "2026-11-20T20:00+03:00",
      venue: { name: "Графит" },
    },
  },
  status: "success",
};

const card = (id: string, account: string, paymentSystem: string) => ({
  account,
  id,
  isDisabled: false,
  paymentSystem,
  paymentWay: "boundCard",
  pspPaymentMethodId: `psp-${id}`,
});

const variants = [
  { id: "sbp-1", paymentWay: "sbpToken" },
  card("card-visa", "427655****4310", "VISA"),
  card("card-mir", "220220****6443", "MIR"),
];

/** A finished preview at `total` kopecks, with the card it is for. */
const preview = (total: number, boundCard = "card-mir") => ({
  orderPreviewCheck: {
    id: "preview-1",
    orderPreviewResult: {
      boundPaymentMethod: { id: boundCard },
      errors: [],
      paymentVariants: variants,
      priceInfo: {
        total: {
          preview: { fee: rub(Math.round(total / 11)), total: rub(total) },
        },
      },
      status: "SUCCESS",
    },
    status: "SUCCESS",
  },
});

const operation = (status: string, redirectUrl3ds?: string): JsonValue => ({
  result: {
    operation: redirectUrl3ds ? { redirectUrl3ds, status } : { status },
  },
  status: "success",
});

const requests: {
  body: JsonValue;
  method: string;
  path: string;
  query: string;
}[] = [];
let answers: Map<string, FakeResponse | FakeResponse[]>;
let previewCard = "card-mir";

const sent = (path: string) => requests.filter((r) => r.path === path);

beforeEach(() => {
  requests.length = 0;
  previewCard = "card-mir";
  answers = new Map<string, FakeResponse | FakeResponse[]>([
    [`/w/sessions/${key}`, { body: null, text: html }],
    [
      "/api/user",
      {
        body: {
          email: { value: "a@ya.ru" },
          fullName: { value: "Савелий Соловьёв" },
          id: "966914271",
          phone: { value: "+79210000000" },
        },
      },
    ],
    [`/api/tickets/v1/sessions/${key}`, { body: session }],
    [
      `/api/session/${key}`,
      {
        body: {
          cart: { cart: { cartId: `puid_966914271_sessionkey_${key}` } },
        },
      },
    ],
    ["/api/antibot/check", { body: { captchaRequired: false, jwt: "jwt" } }],
    [
      `/api/tickets/v4/sessions/${key}/hallplan`,
      { body: { status: "completed", url: planUrl } },
    ],
    ["/hallplans/abc", { body: plan }],
    [
      "/api/session-order-preview/",
      { body: { orderPreviewInit: { id: "preview-1" } } },
    ],
    [
      "/api/tickets/v2/orders/create",
      { body: { result: { order: { id: orderId } }, status: "success" } },
    ],
    [`${orderPath}/operation/reserve`, { body: operation("completed") }],
    [`${orderPath}/operation/pay`, { body: operation("completed") }],
    [`${orderPath}/operation/sale-approve`, { body: operation("completed") }],
    [
      orderPath,
      {
        body: {
          result: {
            order: {
              amountToPay: { total: rub(924000) },
              id: orderId,
              paymentForm: { targetUrl: form },
            },
          },
          status: "success",
        },
      },
    ],
  ]);
  transport.run.mockImplementation(async (_workspace, spec, args) => {
    const answer = await runInPage(spec.run, z.json().parse(args), {
      origin: "https://widget.afisha.yandex.ru/robots.txt",
      respond(url, init) {
        requests.push({
          body: z.json().parse(JSON.parse(init.body ?? "null")),
          method: init.method ?? "GET",
          path: url.pathname,
          query: url.search,
        });
        // The preview names the card it was asked for, as Yandex's does.
        const asked = z
          .object({ quickPurchaseCardId: z.string() })
          .safeParse(JSON.parse(init.body ?? "null")).data;
        if (asked) previewCard = asked.quickPurchaseCardId;
        if (url.pathname === "/api/session-order-preview/preview-1") {
          const fake = answers.get(url.pathname);
          return Array.isArray(fake)
            ? (fake.shift() ?? { body: {}, status: 500 })
            : (fake ?? { body: preview(924000, previewCard) });
        }
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

async function ready(input: Parameters<typeof prepareAfishaPurchase>[1]) {
  const prepared = await prepareAfishaPurchase("workspace:synthetic", input);
  if (prepared.kind !== "ready") throw new Error(prepared.reason);
  return prepared;
}

describe("Afisha ticket purchase", () => {
  it("quotes a zone without seats with the card Yandex offers, holding nothing", async () => {
    const prepared = await ready(target);
    expect(prepared.publicQuote).toEqual({
      amountMinor: 924000,
      currency: "RUB",
      delivery: "Графит, 20 ноября 2026, 20:00; билеты придут на a@ya.ru",
      items: [
        {
          quantity: "2",
          title: "Свидание — VIP-входной (свободная рассадка), без места",
        },
      ],
      payment: "Карта MIR •• 6443",
    });
    expect(prepared.snapshot).toMatchObject({
      amountMinor: 924000,
      cardId: "card-mir",
      count: 2,
      levelId: 8,
      unitMinor: 462000,
    });
    // The bound card is asked for by its id, not the widget's SBP default.
    const previews = sent("/api/session-order-preview/").map(
      ({ body }) => body
    );
    expect(previews.at(-1)).toMatchObject({
      paymentWay: "boundCard",
      quickPurchaseCardId: "card-mir",
    });
    expect(
      z
        .array(z.json())
        .parse(z.object({ items: z.json() }).parse(previews.at(-1)).items)
    ).toHaveLength(2);
    expect(sent("/api/tickets/v2/orders/create")).toHaveLength(0);
  });

  it("pays with the card the person named", async () => {
    const prepared = await ready({ ...target, cardLast4: "4310" });
    expect(prepared.publicQuote.payment).toBe("Карта VISA •• 4310");
    expect(prepared.snapshot.cardId).toBe("card-visa");
  });

  it.each([
    ["a zone with seats", { zone: "VIP Lounge" }, "zone_has_seats"],
    ["more tickets than one order takes", { count: 7 }, "too_many_tickets"],
    [
      "a card the person does not have",
      { cardLast4: "0000" },
      "card_not_found",
    ],
  ])("refuses %s", async (_, change, reason) => {
    expect(
      await prepareAfishaPurchase("workspace:synthetic", {
        ...target,
        ...change,
      })
    ).toEqual({ kind: "blocked", reason });
  });

  it("refuses a total other than the plain sum of the tickets", async () => {
    answers.set("/api/session-order-preview/preview-1", {
      body: preview(900000),
    });
    expect(await prepareAfishaPurchase("workspace:synthetic", target)).toEqual({
      kind: "blocked",
      reason: "money_inconsistent",
    });
  });

  it("places the order once with the saved card and reads the payment", async () => {
    const prepared = await ready(target);
    const placed = await submitAfishaPurchase("workspace:synthetic", {
      amountMinor: prepared.snapshot.amountMinor,
      snapshot: prepared.snapshot,
    });
    expect(placed).toEqual({ kind: "placed", orderId, paymentStatus: "paid" });
    const [create] = sent("/api/tickets/v2/orders/create");
    expect(sent("/api/tickets/v2/orders/create")).toHaveLength(1);
    expect(create?.body).toMatchObject({
      cart_id: `puid_966914271_sessionkey_${key}`,
      clientKey,
      order_preview_id: "preview-1",
      payment_way: "bound-card",
      personal_data: [
        {
          event_sale_personal_data_type: "fullname",
          value: "Савелий Соловьёв",
        },
        { event_sale_personal_data_type: "email", value: "a@ya.ru" },
        {
          event_sale_personal_data_type: "phone-number",
          value: "+79210000000",
        },
      ],
      psp_payment_method_id: "psp-card-mir",
      quick_purchase_card_id: "card-mir",
      session_id: key,
    });
    const items = z
      .array(z.json())
      .parse(z.object({ items: z.json() }).parse(create?.body).items);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      admission: true,
      category_id: 1462978627,
      level_id: 8,
      priceInfo: { total: { currency_code: "rub", value: 462000 } },
      seat: { x_coord: 979, y_coord: 231 },
    });
  });

  // The widget shows the order's payment form when the bank asks: that
  // page, not the operation's flag, is what the person opens.
  it(
    "hands the bank's page to the person when the payment waits for it",
    {
      timeout: 20_000,
    },
    async () => {
      const check = "https://trust.yandex.ru/web/open_3ds?purchase_token=x";
      answers.set(`${orderPath}/operation/pay`, {
        body: operation("running", check),
      });
      const prepared = await ready(target);
      expect(
        await submitAfishaPurchase("workspace:synthetic", {
          amountMinor: prepared.snapshot.amountMinor,
          snapshot: prepared.snapshot,
        })
      ).toEqual({
        confirmUrl: form,
        kind: "placed",
        orderId,
        paymentStatus: "needs_confirmation",
      });
      expect(
        await readAfishaPayment(
          "workspace:synthetic",
          prepared.snapshot,
          orderId
        )
      ).toEqual({ confirmUrl: form, paymentStatus: "needs_confirmation" });
      // Every read of the order carries the widget's client key.
      expect(
        requests
          .filter((r) => r.path.startsWith(orderPath))
          .every((r) => r.query === `?clientKey=${clientKey}`)
      ).toBe(true);
    }
  );

  it("sends nothing when the price changed since the person's yes", async () => {
    const prepared = await ready(target);
    answers.set("/api/session-order-preview/preview-1", {
      body: preview(990000),
    });
    answers.set("/hallplans/abc", {
      body: {
        ...plan,
        result: {
          hallplan: {
            ...plan.result.hallplan,
            levels: [
              {
                ...admission,
                seats: [{ ...admission.seats[0], priceInfo: price(450000) }],
              },
            ],
          },
        },
      },
    });
    expect(
      await submitAfishaPurchase("workspace:synthetic", {
        amountMinor: prepared.snapshot.amountMinor,
        snapshot: prepared.snapshot,
      })
    ).toEqual({ kind: "rejected", reason: "amount_changed" });
    expect(sent("/api/tickets/v2/orders/create")).toHaveLength(0);
  });

  // A server's error after the order went out may come after Yandex made
  // it: only the widget's own checks of the request refuse it for sure.
  it.each([
    ["a lost answer", { body: null, status: 502 }, { kind: "unknown" }],
    [
      "a server's timeout",
      { body: { statusCode: "operation-create-timeout" }, status: 504 },
      { kind: "unknown" },
    ],
    [
      "a conflict",
      { body: { statusCode: "already-done" }, status: 409 },
      { kind: "unknown" },
    ],
    [
      "a phone the widget refuses",
      { body: { statusCode: "invalid-phone" }, status: 400 },
      { kind: "rejected", reason: "afisha_invalid-phone" },
    ],
    [
      "a stale CSRF token",
      { body: { statusCode: "invalid-csrf-token" }, status: 426 },
      { kind: "rejected", reason: "afisha_invalid-csrf-token" },
    ],
  ])("settles %s after sending", async (_, answer, outcome) => {
    const prepared = await ready(target);
    answers.set("/api/tickets/v2/orders/create", answer);
    expect(
      await submitAfishaPurchase("workspace:synthetic", {
        amountMinor: prepared.snapshot.amountMinor,
        snapshot: prepared.snapshot,
      })
    ).toEqual(outcome);
    expect(sent("/api/tickets/v2/orders/create")).toHaveLength(1);
  });

  it("takes an order made with 201", async () => {
    const prepared = await ready(target);
    answers.set("/api/tickets/v2/orders/create", {
      body: { result: { order: { id: orderId } }, status: "success" },
      status: 201,
    });
    expect(
      await submitAfishaPurchase("workspace:synthetic", {
        amountMinor: prepared.snapshot.amountMinor,
        snapshot: prepared.snapshot,
      })
    ).toMatchObject({ kind: "placed", orderId });
  });

  it("calls tickets paid only once they are issued", async () => {
    const prepared = await ready(target);
    const input = {
      amountMinor: prepared.snapshot.amountMinor,
      snapshot: prepared.snapshot,
    };
    answers.set(`${orderPath}/operation/sale-approve`, [
      { body: operation("running") },
      { body: operation("completed") },
    ]);
    expect(await submitAfishaPurchase("workspace:synthetic", input)).toEqual({
      kind: "placed",
      orderId,
      paymentStatus: "paid",
    });
    expect(sent(`${orderPath}/operation/sale-approve`)).toHaveLength(2);
    answers.set(`${orderPath}/operation/sale-approve`, {
      body: operation("failed"),
    });
    expect(await submitAfishaPurchase("workspace:synthetic", input)).toEqual({
      kind: "placed",
      orderId,
      paymentStatus: "failed",
    });
  });

  it("names an order whose own total is not the one agreed", async () => {
    const prepared = await ready(target);
    answers.set(orderPath, {
      body: {
        result: { order: { amountToPay: { total: rub(990000) }, id: orderId } },
        status: "success",
      },
    });
    expect(
      await submitAfishaPurchase("workspace:synthetic", {
        amountMinor: prepared.snapshot.amountMinor,
        snapshot: prepared.snapshot,
      })
    ).toEqual({
      kind: "placed",
      orderId,
      orderTotalMinor: 990000,
      paymentStatus: "paid",
    });
  });

  it("sends nothing on a quote past its term", async () => {
    const prepared = await ready(target);
    expect(
      await submitAfishaPurchase("workspace:synthetic", {
        amountMinor: prepared.snapshot.amountMinor,
        snapshot: {
          ...prepared.snapshot,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      })
    ).toEqual({ kind: "rejected", reason: "quote_expired" });
    expect(sent("/api/tickets/v2/orders/create")).toHaveLength(0);
  });

  it("quotes an expired quote again when nothing in it changed", async () => {
    const prepared = await ready(target);
    const target2 = afishaTarget(prepared.snapshot);
    if (!target2) throw new Error("Expected a target");
    expect(
      await prepareAfishaPurchase(
        "workspace:synthetic",
        target2,
        prepared.snapshot
      )
    ).toMatchObject({ kind: "ready" });
  });

  it("finds a zone written with look-alike letters, and refuses two of one name", async () => {
    // A Cyrillic «Р» in «VIP».
    expect(
      await prepareAfishaPurchase("workspace:synthetic", {
        ...target,
        zone: "VIР-входной (свободная рассадка)",
      })
    ).toMatchObject({ kind: "ready" });
    answers.set("/hallplans/abc", {
      body: {
        ...plan,
        result: {
          hallplan: {
            ...plan.result.hallplan,
            levels: [
              admission,
              { ...admission, id: 9, name: "VIР-входной (свободная рассадка)" },
            ],
          },
        },
      },
    });
    expect(
      await prepareAfishaPurchase("workspace:synthetic", {
        ...target,
        zone: "vip-входной (свободная рассадка)",
      })
    ).toEqual({ kind: "blocked", reason: "zone_ambiguous" });
  });

  it("takes a preview Yandex calls DONE, past another way to pay's error", async () => {
    const done = preview(924000);
    const result = {
      ...done.orderPreviewCheck.orderPreviewResult,
      errors: [{ errorCode: "SBP_NOT_AVAILABLE" }],
      status: "DONE",
    };
    answers.set("/api/session-order-preview/preview-1", {
      body: {
        orderPreviewCheck: {
          ...done.orderPreviewCheck,
          orderPreviewResult: result,
          status: "DONE",
        },
      },
    });
    expect(
      await prepareAfishaPurchase("workspace:synthetic", target)
    ).toMatchObject({
      kind: "ready",
    });
    answers.set("/api/session-order-preview/preview-1", {
      body: {
        orderPreviewCheck: {
          ...done.orderPreviewCheck,
          orderPreviewResult: {
            ...result,
            errors: [{ errorCode: "SEATS_ALREADY_RESERVED" }],
          },
        },
      },
    });
    expect(await prepareAfishaPurchase("workspace:synthetic", target)).toEqual({
      kind: "blocked",
      reason: "preview_seats_already_reserved",
    });
  });

  it("refuses a link whose key steps to another path", async () => {
    expect(
      await prepareAfishaPurchase("workspace:synthetic", {
        ...target,
        link: "https://widget.afisha.yandex.ru/w/sessions/AAAAAAAA%2F%2e%2e%2Fuser",
      })
    ).toEqual({ kind: "blocked", reason: "link_invalid" });
    expect(requests).toHaveLength(0);
  });

  it("reads an expired quote again with its own card", () => {
    expect(
      afishaTarget({
        amountMinor: 924000,
        cardId: "card-visa",
        cartId: "cart",
        categoryId: 1,
        contactsHash: "a".repeat(64),
        count: 2,
        expiresAt: "2026-10-22T12:00:00.000Z",
        extSessionId: 2,
        feeMinor: 84000,
        levelId: 8,
        link,
        sessionKey: key,
        sourceCategoryId: "c",
        sourceLevelId: "l",
        unitMinor: 462000,
        x: 1,
        y: 2,
        zone: "VIP-входной (свободная рассадка)",
      })
    ).toEqual({ ...target, cardId: "card-visa", cardLast4: null });
  });
});

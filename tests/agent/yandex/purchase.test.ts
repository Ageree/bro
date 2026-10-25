import type * as ai from "ai";
import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { YandexPurchase } from "@db/schema/yandex-purchases";
import type * as contacts from "@db/services/contacts";
import type { readOwnContacts } from "@agent/lib/browser-use/facts";
import type * as purchases from "@db/services/yandex-purchases";
import type * as taxiWatches from "@db/services/taxi-watches";
import type * as afisha from "@agent/lib/yandex/afisha/checkout";
import type * as eda from "@agent/lib/yandex/eda/checkout";
import type * as lavka from "@agent/lib/yandex/lavka/checkout";
import type {
  afishaPurchasePilot,
  goOwnRidePilot,
  goPassengerPilot,
  goWatchPilot,
  yandexPurchasePilot,
} from "@agent/lib/yandex/pilot";
import type { makeLoginHandoff } from "@agent/lib/login-handoff/make";
import type { JsonValue } from "@agent/lib/yandex/operations";
import type { runYandexOperation } from "@agent/lib/yandex/transport";

const services = vi.hoisted(() => ({
  makeLink: vi.fn<typeof makeLoginHandoff>(),
  afishaPayment: vi.fn<typeof afisha.readAfishaPayment>(),
  afishaPilot: vi.fn<typeof afishaPurchasePilot>(),
  afishaPrepare: vi.fn<typeof afisha.prepareAfishaPurchase>(),
  afishaSubmit: vi.fn<typeof afisha.submitAfishaPurchase>(),
  claim: vi.fn<typeof purchases.claimYandexPurchase>(),
  contacts: vi.fn<typeof contacts.listContacts>(),
  contactsPilot: vi.fn<typeof contacts.contactsPilot>(),
  create: vi.fn<typeof purchases.createYandexPurchase>(),
  edaPrepare: vi.fn<typeof eda.prepareEdaPurchase>(),
  edaSubmit: vi.fn<typeof eda.submitEdaPurchase>(),
  judge: vi.fn<() => Promise<{ output: { matches: boolean } }>>(),
  ownContacts: vi.fn<typeof readOwnContacts>(),
  ownRidePilot: vi.fn<typeof goOwnRidePilot>(),
  passengerPilot: vi.fn<typeof goPassengerPilot>(),
  startWatch: vi.fn<typeof taxiWatches.startTaxiWatch>(),
  watchPilot: vi.fn<typeof goWatchPilot>(),
  pilot: vi.fn<typeof yandexPurchasePilot>(),
  prepare: vi.fn<typeof lavka.prepareLavkaPurchase>(),
  run: vi.fn<typeof runYandexOperation>(),
  read: vi.fn<typeof purchases.readYandexPurchase>(),
  settle: vi.fn<typeof purchases.settleYandexPurchase>(),
  submit: vi.fn<typeof lavka.submitLavkaPurchase>(),
}));

vi.mock("@db/services/yandex-purchases", () => ({
  claimYandexPurchase: services.claim,
  createYandexPurchase: services.create,
  readYandexPurchase: services.read,
  settleYandexPurchase: services.settle,
}));
vi.mock("@db/services/taxi-watches", () => ({
  startTaxiWatch: services.startWatch,
}));
vi.mock("@db/services/contacts", () => ({
  contactsPilot: services.contactsPilot,
  listContacts: services.contacts,
}));
vi.mock("@agent/lib/browser-use/facts", () => ({
  readOwnContacts: services.ownContacts,
}));
vi.mock("ai", async (original) => ({
  ...(await original<typeof ai>()),
  generateText: services.judge,
}));
vi.mock("@db/services/settings", () => ({
  getWorkspaceModelId: async () => "synthetic/model",
}));
vi.mock("@agent/lib/yandex/transport", () => ({
  runYandexOperation: services.run,
}));
vi.mock("@agent/lib/login-handoff/make", () => ({
  makeLoginHandoff: services.makeLink,
}));
vi.mock("@agent/lib/login-handoff/pilot", () => ({
  loginHandoffPilot: async () => true,
}));
vi.mock("@agent/lib/yandex/pilot", () => ({
  afishaPurchasePilot: services.afishaPilot,
  goOwnRidePilot: services.ownRidePilot,
  goPassengerPilot: services.passengerPilot,
  goWatchPilot: services.watchPilot,
  yandexPurchasePilot: services.pilot,
}));
vi.mock("@agent/lib/yandex/afisha/checkout", async (original) => ({
  ...(await original<typeof afisha>()),
  prepareAfishaPurchase: services.afishaPrepare,
  readAfishaPayment: services.afishaPayment,
  submitAfishaPurchase: services.afishaSubmit,
}));
vi.mock("@agent/lib/yandex/eda/checkout", async (original) => ({
  ...(await original<typeof eda>()),
  prepareEdaPurchase: services.edaPrepare,
  submitEdaPurchase: services.edaSubmit,
}));
vi.mock("@agent/lib/yandex/lavka/checkout", async (original) => ({
  ...(await original<typeof lavka>()),
  prepareLavkaPurchase: services.prepare,
  submitLavkaPurchase: services.submit,
}));

import purchaseTools from "@agent/tools/yandex_purchase";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const scope = { userId: "alice", workspaceId: "workspace:alice" };
const purchaseId = "6f6f5d78-641b-4c80-aacf-eec05af14e53";
const question = "Яндекс Лавка: вода, итого 249,50 ₽ с доставкой. Оплачиваю?";
const quote = {
  amountMinor: 24_950,
  currency: "RUB" as const,
  delivery: "Сохранённый тестовый адрес",
  items: [{ quantity: "1", title: "Вода" }],
  payment: "Сохранённая карта",
};

const snapshot = {
  addressHash: "a".repeat(64),
  addressId: "synthetic-address",
  addressVersion: 1,
  amountMinor: 24_950,
  cartId: "synthetic-cart",
  cartVersion: 3,
  deliveryConditionsId: "synthetic-delivery",
  deliveryMinor: 19_950,
  deliveryType: "eats_dispatch" as const,
  expiresAt: "2099-01-01T00:00:00.000Z",
  flowVersion: "grocery_flow_v1" as const,
  items: [
    {
      id: "synthetic-item",
      positionId: "synthetic-position",
      quantity: "1",
      title: "Вода",
      unitPriceMinor: 5_000,
    },
  ],
  itemsMinor: 5_000,
  offerId: "synthetic-offer",
  payment: {
    currency: "RUB" as const,
    id: "synthetic-card",
    last4: null,
    source: "diehard" as const,
    system: "VISA" as const,
    type: "card" as const,
    verifyStrategy: "card_antifraud" as const,
  },
  validUntil: "2099-01-01T00:00:00.000Z",
  version: 1 as const,
};

function row(overrides: Partial<YandexPurchase> = {}): YandexPurchase {
  return {
    ...scope,
    amountMinor: quote.amountMinor,
    callId: null,
    checkoutKey: "synthetic-cart",
    confirmationQuestion: question,
    createdAt: new Date(),
    currency: "RUB",
    expiresAt: new Date(Date.now() + 60_000),
    fingerprint: "synthetic-fingerprint",
    id: purchaseId,
    merchantOrderId: null,
    outcome: null,
    phase: null,
    providerSnapshot: snapshot,
    publicQuote: quote,
    rootSessionId: "session-1",
    service: "lavka",
    settledAt: null,
    state: "quoted",
    submittedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function caller(authenticator = "authjs") {
  return {
    attributes: { conversationChannel: "eve", workspaceId: scope.workspaceId },
    authenticator,
    principalId: scope.userId,
    principalType: "user" as const,
  };
}

function resolveContext(
  messages: ModelMessage[],
  authenticator = "authjs"
): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: {
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
    },
  };
}

function callContext(): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: () => {
      throw new Error("No sandbox");
    },
    getSkill: () => {
      throw new Error("No skill");
    },
    getToken: () => {
      throw new Error("No token");
    },
    requireAuth: (): never => {
      throw new Error("No token");
    },
    session: {
      auth: { current: caller(), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "yandex_purchase",
  };
}

function answered(
  text = "да",
  asked = question,
  delivered = true
): ModelMessage[] {
  return [
    { role: "user", content: "Подготовь мою корзину к оплате" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolName: "send_message",
          toolCallId: "send-1",
          input: { text: asked },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "send_message",
          toolCallId: "send-1",
          output: {
            type: "json",
            value: { status: delivered ? "sent" : "failed" },
          },
        },
      ],
    },
    { role: "user", content: text },
  ];
}

async function resolve(messages = answered(), authenticator = "authjs") {
  const tools = await purchaseTools.events["step.started"]?.(
    {},
    resolveContext(messages, authenticator)
  );
  return tools && "yandex_purchase" in tools
    ? tools.yandex_purchase
    : undefined;
}

async function confirm(messages = answered(), context = callContext()) {
  const tool = await resolve(messages);
  if (!tool) throw new Error("Expected purchase tool");
  return tool.execute({ action: "confirm", purchaseId }, context);
}

beforeEach(() => {
  vi.resetAllMocks();
  services.pilot.mockReturnValue(true);
  services.ownContacts.mockResolvedValue({ emails: [], phones: [] });
  services.ownRidePilot.mockReturnValue(false);
  services.watchPilot.mockReturnValue(false);
  services.judge.mockResolvedValue({ output: { matches: false } });
  services.read.mockResolvedValue(row());
  services.claim.mockResolvedValue({
    kind: "claimed",
    purchase: row({
      state: "submitting",
      callId: "call-1",
      submittedAt: new Date(),
    }),
  });
  services.submit.mockResolvedValue({
    kind: "placed",
    orderId: "synthetic-order",
    paymentStatus: "paid",
  });
  services.settle.mockResolvedValue(
    row({ state: "placed", merchantOrderId: "synthetic-order" })
  );
  services.prepare.mockResolvedValue({
    kind: "ready",
    checkoutKey: "synthetic-cart",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    publicQuote: quote,
    snapshot,
  });
  services.create.mockResolvedValue({ kind: "created", purchase: row() });
});

/** An Afisha prepare of the «Свидание» zone, at a session's link and time. */
const afishaPrepareInput = (link: string, when: string) => ({
  action: "prepare" as const,
  cardLast4: null,
  count: 2,
  link,
  service: "afisha" as const,
  when,
  zone: "VIP-входной (свободная рассадка)",
});

describe("Yandex purchase consent", () => {
  it("does not add a tool outside the purchase pilot or in a report turn", async () => {
    services.pilot.mockReturnValue(false);
    expect(await resolve()).toBeUndefined();
    services.pilot.mockReturnValue(true);
    expect(await resolve(answered(), "scheduled-worker")).toBeUndefined();
    expect(
      await resolve([
        { role: "user", content: `${backgroundTurnMarker}\nPay now` },
      ])
    ).toBeUndefined();
    expect(services.submit).not.toHaveBeenCalled();
  });

  it("prepares an exact server-authored question without submitting", async () => {
    const tool = await resolve();
    await tool?.execute({ action: "prepare", service: "lavka" }, callContext());
    expect(services.create).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        amountMinor: 24_950,
        currency: "RUB",
        rootSessionId: "session-1",
        service: "lavka",
      })
    );
    const prepared = services.create.mock.calls[0]?.[1];
    expect(prepared?.confirmationQuestion).toContain("249,50 ₽");
    expect(prepared?.confirmationQuestion).toMatch(/Оплачиваю\?$/u);
    expect(prepared?.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 300_000
    );
    expect(services.submit).not.toHaveBeenCalled();
  });

  it("asks about an Eda order in Eda's name and places it through Eda", async () => {
    const target = { lat: 55.7, lon: 37.5, place: "karavaevy" };
    const edaSnapshot = {
      ...target,
      addressId: "home",
      addressVersion: 1,
      amountMinor: 24_950,
      cardId: "card-x1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      items: [{ id: 1, positionId: 7, priceMinor: 5_000, quantity: 1 }],
    };
    services.edaPrepare.mockResolvedValue({
      checkoutKey: "karavaevy:home",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      kind: "ready",
      publicQuote: quote,
      snapshot: edaSnapshot,
    });
    const tool = await resolve();
    await tool?.execute(
      { action: "prepare", service: "eda", ...target },
      callContext()
    );
    expect(services.edaPrepare).toHaveBeenCalledWith(
      scope.workspaceId,
      expect.objectContaining(target)
    );
    const prepared = services.create.mock.calls[0]?.[1];
    expect(prepared?.service).toBe("eda");
    expect(prepared?.confirmationQuestion).toMatch(/^Яндекс Еда: «Вода» × 1/u);
    const edaRow = row({ service: "eda", providerSnapshot: edaSnapshot });
    services.read.mockResolvedValue(edaRow);
    services.claim.mockResolvedValue({
      kind: "claimed",
      purchase: { ...edaRow, callId: "call-1", state: "submitting" },
    });
    services.edaSubmit.mockResolvedValue({
      kind: "placed",
      orderId: "261012-1",
      paymentStatus: "paid",
    });
    expect(await confirm()).toMatchObject({ kind: "placed" });
    expect(services.edaSubmit).toHaveBeenCalledWith(scope.workspaceId, {
      amountMinor: 24_950,
      snapshot: edaSnapshot,
    });
    expect(services.submit).not.toHaveBeenCalled();
  });

  it("asks about Afisha tickets in Afisha's name and places them through the widget, only in its pilot", async () => {
    const link =
      "https://widget.afisha.yandex.ru/w/sessions/MzIzNDJ8ODI5ODU1?widgetName=w1";
    const target = {
      cardLast4: null,
      count: 2,
      link,
      when: "2026-11-20T20:00",
      zone: "VIP-входной (свободная рассадка)",
    };
    const ticketSnapshot = {
      amountMinor: 924_000,
      cardId: "card-mir",
      cartId: "cart",
      categoryId: 1,
      contactsHash: "a".repeat(64),
      count: 2,
      expiresAt: "2099-01-01T00:00:00.000Z",
      extSessionId: 2,
      feeMinor: 84_000,
      levelId: 8,
      link,
      sessionKey: "MzIzNDJ8ODI5ODU1",
      sourceCategoryId: "c",
      sourceLevelId: "l",
      unitMinor: 462_000,
      x: 1,
      y: 2,
      zone: target.zone,
    };
    const tickets = {
      amountMinor: 924_000,
      currency: "RUB" as const,
      delivery: "Графит, 20 ноября 2026, 20:00",
      items: [
        {
          quantity: "2",
          title: "Свидание — VIP-входной (свободная рассадка), без места",
        },
      ],
      payment: "Карта MIR •• 6443",
    };
    services.afishaPilot.mockReturnValue(false);
    expect(
      await (
        await resolve()
      )?.execute(
        { action: "prepare", service: "afisha", ...target },
        callContext()
      )
    ).toEqual({ kind: "unavailable" });
    expect(services.afishaPrepare).not.toHaveBeenCalled();

    services.afishaPilot.mockReturnValue(true);
    services.afishaPrepare.mockResolvedValue({
      checkoutKey: "MzIzNDJ8ODI5ODU1:8:2",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      kind: "ready",
      publicQuote: tickets,
      snapshot: ticketSnapshot,
    });
    await (
      await resolve()
    )?.execute(
      { action: "prepare", service: "afisha", ...target },
      callContext()
    );
    const prepared = services.create.mock.calls[0]?.[1];
    expect(prepared?.service).toBe("afisha");
    expect(prepared?.confirmationQuestion).toMatch(
      /^Яндекс Афиша: «Свидание — VIP-входной \(свободная рассадка\), без места» × 2\. Где и когда: Графит, 20 ноября 2026, 20:00\. .+ Итого 9\s240,00 ₽, включая сервисный сбор\./u
    );
    const ticketRow = row({
      amountMinor: 924_000,
      confirmationQuestion: prepared?.confirmationQuestion ?? "",
      providerSnapshot: ticketSnapshot,
      publicQuote: tickets,
      service: "afisha",
    });
    services.read.mockResolvedValue(ticketRow);
    services.claim.mockResolvedValue({
      kind: "claimed",
      purchase: { ...ticketRow, callId: "call-1", state: "submitting" },
    });
    services.afishaSubmit.mockResolvedValue({
      confirmUrl: "https://trust.yandex.ru/web/open_3ds?purchase_token=x",
      kind: "placed",
      orderId: "1792665431815@fac1927e",
      paymentStatus: "needs_confirmation",
    });
    expect(
      await confirm(answered("да", prepared?.confirmationQuestion ?? ""))
    ).toMatchObject({ kind: "placed" });
    expect(services.afishaSubmit).toHaveBeenCalledWith(scope.workspaceId, {
      amountMinor: 924_000,
      snapshot: ticketSnapshot,
    });
    expect(services.submit).not.toHaveBeenCalled();
  });

  it("tells the model what to do next on an Afisha refusal, with no card it made up", async () => {
    services.afishaPilot.mockReturnValue(true);
    services.afishaPrepare.mockResolvedValue({
      kind: "blocked",
      reason: "zone_has_seats",
    });
    const tool = await resolve(answered("купи два билета в VIP Lounge"));
    const result = await tool?.execute(
      {
        action: "prepare",
        cardLast4: "1234",
        count: 2,
        link: "https://widget.afisha.yandex.ru/w/sessions/MzIzNDJ8ODI5ODU1",
        service: "afisha",
        when: "2026-11-20T20:00",
        zone: "VIP Lounge",
      },
      callContext()
    );
    expect(result).toMatchObject({ kind: "blocked", reason: "zone_has_seats" });
    expect(JSON.stringify(result)).toContain("browser_task");
    // The person named no card: the model's digits are not passed on.
    expect(services.afishaPrepare.mock.calls[0]?.[1]).toMatchObject({
      cardLast4: null,
    });
    await (
      await resolve(answered("купи два билета, карта 4310"))
    )?.execute(
      {
        action: "prepare",
        cardLast4: "4310",
        count: 2,
        link: "https://widget.afisha.yandex.ru/w/sessions/MzIzNDJ8ODI5ODU1",
        service: "afisha",
        when: "2026-11-20T20:00",
        zone: "VIP Lounge",
      },
      callContext()
    );
    expect(services.afishaPrepare.mock.calls[1]?.[1]).toMatchObject({
      cardLast4: "4310",
    });
  });

  it("asks again for Afisha tickets whose earlier order was not paid, and never past a paid one", async () => {
    services.afishaPilot.mockReturnValue(true);
    const link = "https://widget.afisha.yandex.ru/w/sessions/MzIzNDJ8ODI5ODU1";
    const ticketSnapshot = {
      amountMinor: 924_000,
      cardId: "card-mir",
      cartId: "cart",
      categoryId: 1,
      contactsHash: "a".repeat(64),
      count: 2,
      expiresAt: "2099-01-01T00:00:00.000Z",
      extSessionId: 2,
      feeMinor: 84_000,
      levelId: 8,
      link,
      sessionKey: "MzIzNDJ8ODI5ODU1",
      sourceCategoryId: "c",
      sourceLevelId: "l",
      unitMinor: 462_000,
      x: 1,
      y: 2,
      zone: "Танцпол",
    };
    const tickets = {
      amountMinor: 924_000,
      currency: "RUB" as const,
      delivery: "Графит, 20 ноября 2026, 20:00",
      items: [{ quantity: "2", title: "Свидание — Танцпол, без места" }],
      payment: "Карта MIR •• 6443",
    };
    services.afishaPrepare.mockResolvedValue({
      checkoutKey: "MzIzNDJ8ODI5ODU1:8:2",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      kind: "ready",
      publicQuote: tickets,
      snapshot: ticketSnapshot,
    });
    const placed = row({
      merchantOrderId: "1792665431815@fac1927e",
      outcome: { kind: "placed", paymentStatus: "needs_confirmation" },
      providerSnapshot: ticketSnapshot,
      publicQuote: tickets,
      service: "afisha",
      state: "placed",
    });
    const input = {
      action: "prepare" as const,
      cardLast4: null,
      count: 2,
      link,
      service: "afisha" as const,
      when: "2026-11-20T20:00",
      zone: "Танцпол",
    };
    services.create
      .mockResolvedValueOnce({ kind: "existing", purchase: placed })
      .mockResolvedValueOnce({
        kind: "created",
        purchase: row({ publicQuote: tickets, service: "afisha" }),
      });
    services.afishaPayment.mockResolvedValueOnce({ paymentStatus: "failed" });
    expect(
      await (
        await resolve(answered("купи два на танцпол"))
      )?.execute(input, callContext())
    ).toMatchObject({ kind: "quoted" });
    const [first, second] = services.create.mock.calls.map(
      ([, record]) => record.fingerprint
    );
    expect(second).not.toBe(first);

    services.create.mockReset();
    services.create.mockResolvedValue({ kind: "existing", purchase: placed });
    services.afishaPayment.mockResolvedValueOnce({ paymentStatus: "paid" });
    expect(
      await (
        await resolve(answered("купи два на танцпол"))
      )?.execute(input, callContext())
    ).toMatchObject({ kind: "placed", paymentStatus: "paid" });
    expect(services.create).toHaveBeenCalledTimes(1);
  });

  // 22.10 the model copied the session's base64 key with a slip, and
  // Afisha answered 404: the link afisha.prices gave stands instead.
  it("takes the Afisha session's link from afisha.prices, not the model's copy", async () => {
    services.afishaPilot.mockReturnValue(true);
    services.afishaPrepare.mockResolvedValue({
      kind: "blocked",
      reason: "zone_not_found",
    });
    const real =
      "https://widget.afisha.yandex.ru/w/sessions/MzIzNDJ8ODI5ODU1fDE0MDQ3NjE4fDE3OTUxOTQwMDAwMDA=";
    const priced: ModelMessage[] = [
      { role: "user", content: "купи два VIP на Свидание" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "yandex",
            toolCallId: "prices-1",
            input: { operation: "afisha.prices" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "yandex",
            toolCallId: "prices-1",
            output: {
              type: "json",
              value: {
                data: { sessions: [{ link: real, when: "2026-11-20T20:00" }] },
                ok: true,
              },
            },
          },
        ],
      },
      ...answered("да").slice(1),
    ];
    const tool = await resolve(priced);
    await tool?.execute(
      afishaPrepareInput(
        "https://widget.afisha.yandex.ru/w/sessions/MzIzNDJ8ODI5ODU1fDE0MDQ3NjE4fDE3OTE5NDAwMDAwMDA=",
        "2026-11-20T20:00"
      ),
      callContext()
    );
    expect(services.afishaPrepare.mock.calls[0]?.[1]).toMatchObject({
      link: real,
    });
    // No session of that time either: nothing is read, the model is told.
    expect(
      await tool?.execute(
        afishaPrepareInput(
          "https://widget.afisha.yandex.ru/w/sessions/AAAAAAAAAAAA",
          "2026-11-21T20:00"
        ),
        callContext()
      )
    ).toMatchObject({ kind: "blocked", reason: "session_unknown" });
    expect(services.afishaPrepare).toHaveBeenCalledTimes(1);
  });

  it("buys no Afisha quote once its pilot is off", async () => {
    services.afishaPilot.mockReturnValue(false);
    services.read.mockResolvedValue(row({ service: "afisha" }));
    expect(await confirm()).toEqual({ kind: "unavailable" });
    expect(services.claim).not.toHaveBeenCalled();
  });

  it.each([
    ["да", "Другой товар за 249,50 ₽. Оплачиваю?", true],
    ["да, но дешевле", question, true],
    ["нет", question, true],
    ["да", question, false],
  ])("refuses absent exact consent: %s", async (answer, asked, delivered) => {
    expect(await confirm(answered(answer, asked, delivered))).toMatchObject({
      kind: "confirmation_required",
    });
    expect(services.claim).not.toHaveBeenCalled();
    expect(services.submit).not.toHaveBeenCalled();
  });

  it("tells the model not to ask again when the checkout is blocked", async () => {
    services.prepare.mockResolvedValue({
      kind: "blocked",
      reason: "money_inconsistent",
    });
    const tool = await resolve();
    const result = await tool?.execute(
      { action: "prepare", service: "lavka" },
      callContext()
    );
    expect(result).toMatchObject({
      kind: "blocked",
      reason: "money_inconsistent",
    });
    expect(JSON.stringify(result)).toContain("do not call prepare again");
    expect(services.create).not.toHaveBeenCalled();
  });

  it("claims durably before sending the exact stored snapshot", async () => {
    expect(await confirm()).toMatchObject({
      kind: "placed",
      orderId: "synthetic-order",
    });
    expect(services.claim).toHaveBeenCalledWith(scope, {
      callId: "call-1",
      confirmationQuestion: question,
      id: purchaseId,
      rootSessionId: "session-1",
    });
    expect(services.submit).toHaveBeenCalledWith(scope.workspaceId, {
      amountMinor: 24_950,
      snapshot: row().providerSnapshot,
    });
    expect(services.claim.mock.invocationCallOrder[0]).toBeLessThan(
      services.submit.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("takes the yes to the question Bro delivered with its own quotes, not to another total", async () => {
    const stored = 'Яндекс Лавка: "Вода" × 1. Итого 249,50 ₽. Оплачиваю?';
    services.read.mockResolvedValue(row({ confirmationQuestion: stored }));
    expect(
      await confirm(
        answered("да", "Яндекс Лавка: «Вода» × 1.  Итого 249,50 ₽. Оплачиваю?")
      )
    ).toMatchObject({ kind: "placed" });
    expect(
      await confirm(
        answered("да", "Яндекс Лавка: «Вода» × 1. Итого 149,50 ₽. Оплачиваю?")
      )
    ).toMatchObject({ kind: "confirmation_required" });
    expect(services.submit).toHaveBeenCalledTimes(1);
  });

  it("takes one yes to Bro's own question about this order, not a second question", async () => {
    const own =
      "Нашёл воду, беру одну бутылку. Итого с доставкой 249,50 ₽. Оплачиваю?";
    services.judge.mockResolvedValue({ output: { matches: true } });
    expect(await confirm(answered("Да", own))).toMatchObject({
      kind: "placed",
    });
    expect(services.submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another total", "Вода, итого 199 ₽. Оплачиваю?", true],
    ["other items", "Вода и хлеб, итого 249,50 ₽. Оплачиваю?", false],
  ])("refuses a yes to Bro's own question with %s", async (_, own, judged) => {
    expect(await confirm(answered("да", own))).toMatchObject({
      kind: "confirmation_required",
    });
    expect(services.judge).toHaveBeenCalledTimes(judged ? 0 : 1);
    expect(services.submit).not.toHaveBeenCalled();
  });

  it("tells the model to confirm when the person already said yes to this total", async () => {
    const tool = await resolve(
      answered("да", "Вода, итого 249,50 ₽ с доставкой. Оплачиваю?")
    );
    const result = await tool?.execute(
      { action: "prepare", service: "lavka" },
      callContext()
    );
    expect(result).toMatchObject({ kind: "quoted" });
    expect(JSON.stringify(result)).toContain("Call confirm");
    expect(services.submit).not.toHaveBeenCalled();
  });

  it("renews an expired unchanged Lavka quote under the same explicit yes and one claim", async () => {
    const expired = row({ expiresAt: new Date(0) });
    const fresh = { ...snapshot, offerId: "renewed-offer" };
    services.read.mockResolvedValue(expired);
    services.prepare.mockResolvedValue({
      kind: "ready",
      checkoutKey: fresh.cartId,
      expiresAt: fresh.expiresAt,
      publicQuote: quote,
      snapshot: fresh,
    });
    services.claim.mockImplementation(async (_scope, input) =>
      input.refresh
        ? {
            kind: "claimed",
            purchase: row({ ...input.refresh, state: "submitting" }),
          }
        : { kind: "expired", purchase: expired }
    );
    expect(await confirm()).toMatchObject({ kind: "placed" });
    expect(services.prepare).toHaveBeenCalledWith(
      scope.workspaceId,
      expired.providerSnapshot
    );
    expect(services.claim).toHaveBeenCalledTimes(1);
    expect(services.claim).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        id: purchaseId,
        confirmationQuestion: question,
      })
    );
    expect(services.submit).toHaveBeenCalledWith(scope.workspaceId, {
      amountMinor: quote.amountMinor,
      snapshot: fresh,
    });
    expect(services.submit).toHaveBeenCalledTimes(1);
  });

  it("refuses an expired claim without calling Yandex", async () => {
    services.claim.mockResolvedValue({
      kind: "expired",
      purchase: row({ expiresAt: new Date(0) }),
    });
    expect(await confirm()).toMatchObject({ kind: "expired" });
    expect(services.submit).not.toHaveBeenCalled();
  });

  it.each(["submitting", "placed", "rejected"] as const)(
    "does not resend a %s attempt",
    async (state) => {
      services.read.mockResolvedValue(row({ state }));
      await confirm();
      expect(services.claim).not.toHaveBeenCalled();
      expect(services.submit).not.toHaveBeenCalled();
    }
  );

  it("does not resend when a concurrent caller already claimed the quote", async () => {
    services.claim.mockResolvedValue({
      kind: "existing",
      purchase: row({ state: "submitting" }),
    });
    expect(await confirm()).toMatchObject({ kind: "unknown" });
    expect(services.submit).not.toHaveBeenCalled();
  });

  it("records an ambiguous network failure without retrying or buying through a browser", async () => {
    services.submit.mockRejectedValue(new Error("network"));
    services.settle.mockResolvedValue(row({ state: "unknown" }));
    const result = await confirm();
    expect("kind" in result ? result.kind : undefined).toBe("unknown");
    expect("reply" in result ? result.reply : "").toContain("Do not repeat");
    expect(services.submit).toHaveBeenCalledTimes(1);
    expect(services.settle).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        state: "unknown",
        outcome: { kind: "unknown" },
      })
    );
  });

  it("keeps an ambiguous result when persistence fails after the external call", async () => {
    services.settle.mockRejectedValue(new Error("database unavailable"));
    expect(await confirm()).toMatchObject({
      kind: "unknown",
      orderId: "synthetic-order",
    });
    expect(services.submit).toHaveBeenCalledTimes(1);
  });

  it("checks the actor again before execution", async () => {
    const original = callContext();
    const context = {
      ...original,
      session: {
        ...original.session,
        auth: {
          ...original.session.auth,
          current: { ...caller(), principalId: "mallory" },
        },
      },
    };
    expect(await confirm(answered(), context)).toMatchObject({
      kind: "unavailable",
    });
    expect(services.read).not.toHaveBeenCalled();
    expect(services.submit).not.toHaveBeenCalled();
  });

  it("does not expose private provider data when reading an attempt", async () => {
    const tool = await resolve();
    const result = await tool?.execute(
      { action: "status", purchaseId },
      callContext()
    );
    expect(JSON.stringify(result)).not.toMatch(
      /cartVersion|synthetic-cart|providerSnapshot|fingerprint/u
    );
  });
});

/** What the transport answers for an operation that went through. */
const answer = (data: JsonValue) => ({ data, kind: "ok" as const });

describe("Yandex Go with an unverified card", () => {
  const verifyUrl =
    "https://trust.yandex.ru/web/binding?verification_intent_id=verification_intent_1";
  const book = {
    action: "book" as const,
    from: "Дом",
    near: [37.6177, 55.7558] satisfies [number, number],
    payment: "card" as const,
    service: "go" as const,
    to: "Раменки",
  };

  beforeEach(() => {
    services.run.mockImplementation(async (_workspace, operation) =>
      operation.id === "go.book"
        ? answer({
            kind: "failed",
            reason: "no_verified_card",
            unverifiedCardId: "card-x2b",
          })
        : answer({
            kind: "link",
            card: "Мир •••• 6443",
            last4: "6443",
            url: verifyUrl,
          })
    );
  });

  it("gives the person one bank link for the card, not a new one each try", async () => {
    const tool = await resolve([
      { role: "user", content: "Вызови такси до Раменок, по карте" },
    ]);
    const first = await tool?.execute(book, callContext());
    expect(first).toMatchObject({
      kind: "failed",
      card: "Мир •••• 6443",
      cardLast4: "6443",
      verifyUrl,
    });
    expect(JSON.stringify(first)).not.toContain("card-x2b");
    expect(services.run).toHaveBeenLastCalledWith(
      scope.workspaceId,
      expect.objectContaining({ id: "go.card_verify" }),
      { cardId: "card-x2b", near: [37.6177, 55.7558] }
    );
    expect(await tool?.execute(book, callContext())).toMatchObject({
      verifyUrl,
    });
    expect(
      services.run.mock.calls.filter(
        ([, operation]) => operation.id === "go.card_verify"
      )
    ).toHaveLength(1);
  });

  it("falls back to the Go app when no link can be made", async () => {
    services.run.mockImplementation(async (_workspace, operation) =>
      operation.id === "go.book"
        ? answer({
            kind: "failed",
            reason: "no_verified_card",
            unverifiedCardId: "card-x3c",
          })
        : { kind: "ok", data: { kind: "failed", reason: "trust_400" } }
    );
    const tool = await resolve([
      { role: "user", content: "Такси до Раменок по карте" },
    ]);
    const result = await tool?.execute(book, callContext());
    expect(result).not.toHaveProperty("verifyUrl");
    expect(JSON.stringify(result)).toContain("Yandex Go app");
  });

  it("gives the bank's link on its own, for the onboarding, booking nothing", async () => {
    const tool = await resolve([
      { role: "user", content: "Да, присылай ссылку банка" },
    ]);
    const result = await tool?.execute(
      { action: "verify_card", cardId: "card-x4d" },
      callContext()
    );
    expect(result).toMatchObject({ kind: "verify_card", verifyUrl });
    expect(JSON.stringify(result)).toContain("account.ready");
    expect(JSON.stringify(result)).not.toContain("book again");
    expect(services.run).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId,
      expect.objectContaining({ id: "go.card_verify" }),
      { cardId: "card-x4d" }
    );
  });
});

describe("Yandex Go for another person", () => {
  const ride = {
    action: "book" as const,
    from: "Мичуринский проспект, 56",
    near: [37.6177, 55.7558] satisfies [number, number],
    payment: "current" as const,
    service: "go" as const,
    to: "Гвидон",
  };
  const booked = answer({
    kind: "booked",
    orderId: "new-order",
    status: "search",
    price: 780,
    from: "Мичуринский проспект, 56",
    to: "Гвидон",
    payment: "наличные",
    passenger: { name: "Маша", phone: "+79161234567" },
  });

  beforeEach(() => {
    services.passengerPilot.mockReturnValue(true);
  });

  it("takes no passenger outside its pilot", async () => {
    services.passengerPilot.mockReturnValue(false);
    const tool = await resolve([
      { role: "user", content: "Закажи такси Маше, её номер 8 916 123-45-67" },
    ]);
    const schema = z
      .custom<z.ZodType>((value) => value instanceof z.ZodType)
      .parse(tool?.inputSchema);
    expect(
      schema.safeParse({ ...ride, passengerPhone: "+79161234567" }).success
    ).toBe(false);
    expect(schema.safeParse(ride).success).toBe(true);
  });

  it("books a ride for the passenger whose number the person wrote", async () => {
    services.run.mockResolvedValue(booked);
    const tool = await resolve([
      {
        role: "user",
        content: "Закажи такси Маше до Гвидона, её номер 8 916 123-45-67",
      },
    ]);
    const result = await tool?.execute(
      { ...ride, passengerName: "Маша", passengerPhone: "89161234567" },
      callContext()
    );
    expect(services.run).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId,
      expect.objectContaining({ id: "go.book" }),
      expect.objectContaining({
        passengerName: "Маша",
        passengerPhone: "+79161234567",
      })
    );
    expect(result).toMatchObject({ kind: "booked" });
    expect(JSON.stringify(result)).toContain("Yandex texts the passenger");
  });

  it("takes the passenger's number from the person's contacts", async () => {
    services.run.mockResolvedValue(booked);
    services.contactsPilot.mockReturnValue(true);
    services.contacts.mockResolvedValue([
      {
        aliases: ["мама"],
        createdAt: new Date(),
        familiar: true,
        id: "contact-1",
        name: "Мама",
        note: null,
        phones: ["+79161234567"],
        searchKey: "мама",
        updatedAt: new Date(),
        workspaceId: scope.workspaceId,
      },
    ]);
    const tool = await resolve([
      { role: "user", content: "Вызови маме такси до Гвидона" },
    ]);
    await tool?.execute(
      { ...ride, passengerPhone: "+79161234567" },
      callContext()
    );
    expect(services.run).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId,
      expect.objectContaining({ id: "go.book" }),
      expect.objectContaining({ passengerPhone: "+79161234567" })
    );
  });

  it("books nothing for a number the person never gave, and their own ride without one", async () => {
    services.run.mockResolvedValue(booked);
    const tool = await resolve([
      { role: "user", content: "Закажи такси до Гвидона" },
    ]);
    const refused = await tool?.execute(
      { ...ride, passengerPhone: "+79990001122" },
      callContext()
    );
    expect(refused).toMatchObject({ kind: "not_booked" });
    expect(services.run).not.toHaveBeenCalled();
    // A model fills every optional field: an empty one is the person's ride.
    await tool?.execute({ ...ride, passengerPhone: "" }, callContext());
    expect(services.run).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId,
      expect.objectContaining({ id: "go.book" }),
      expect.objectContaining({ passengerPhone: undefined })
    );
  });

  it("books the person's own number as their own ride, not one for someone else", async () => {
    services.run.mockResolvedValue(
      answer({
        kind: "booked",
        orderId: "new-order",
        status: "search",
        price: 780,
        from: "Мичуринский проспект, 56",
        to: "Гвидон",
        payment: "наличные",
      })
    );
    services.ownContacts.mockResolvedValue({
      emails: [],
      phones: ["8 (916) 123-45-67"],
    });
    const tool = await resolve([
      {
        role: "user",
        content: "Вызови мне такси до Гвидона, мой номер +7 916 123-45-67",
      },
    ]);
    const result = await tool?.execute(
      { ...ride, passengerName: "Я", passengerPhone: "+79161234567" },
      callContext()
    );
    expect(services.run).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId,
      expect.objectContaining({ id: "go.book" }),
      expect.objectContaining({
        passengerName: undefined,
        passengerPhone: undefined,
      })
    );
    expect(JSON.stringify(result)).not.toContain("passenger");
  });

  it("keeps a passenger whose number shares the person's phone field with theirs", async () => {
    services.run.mockResolvedValue(booked);
    services.ownContacts.mockResolvedValue({
      emails: [],
      phones: ["+7 903 111-22-33, жена +7 916 123-45-67"],
    });
    const tool = await resolve([
      {
        role: "user",
        content: "Закажи такси жене до Гвидона, её номер 8 916 123-45-67",
      },
    ]);
    await tool?.execute(
      { ...ride, passengerPhone: "+79161234567" },
      callContext()
    );
    expect(services.run).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId,
      expect.objectContaining({ id: "go.book" }),
      expect.objectContaining({ passengerPhone: "+79161234567" })
    );
  });
});

describe("the person's own Yandex Go ride", () => {
  const ride = {
    action: "book" as const,
    from: "Мичуринский проспект, 56",
    near: [37.6177, 55.7558] satisfies [number, number],
    payment: "current" as const,
    service: "go" as const,
    to: "Гвидон",
  };
  const booked = {
    kind: "booked",
    orderId: "new-order",
    status: "search",
    price: 780,
    from: "Мичуринский проспект, 56",
    to: "Гвидон",
    payment: "наличные",
  } satisfies Record<string, JsonValue>;

  it("goes as the person's Go app books it in the pilot", async () => {
    services.ownRidePilot.mockReturnValue(true);
    services.run.mockResolvedValue(answer(booked));
    const tool = await resolve([
      { role: "user", content: "Вызови мне такси до Гвидона" },
    ]);
    const schema = z
      .custom<z.ZodType>((value) => value instanceof z.ZodType)
      .parse(tool?.inputSchema);
    // The model never says how the ride goes.
    expect(schema.safeParse({ ...ride, quietOwnRide: false }).success).toBe(
      false
    );
    const result = await tool?.execute(ride, callContext());
    expect(services.run).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId,
      expect.objectContaining({ id: "go.book" }),
      expect.objectContaining({ quietOwnRide: true })
    );
    expect(JSON.stringify(result)).toContain("their Yandex Go app");
  });

  it("tells of the person's own ride when Go found the passenger's number to be the account's", async () => {
    services.ownRidePilot.mockReturnValue(true);
    services.passengerPilot.mockReturnValue(true);
    services.run.mockResolvedValue(answer(booked));
    const tool = await resolve([
      {
        role: "user",
        content: "Вызови мне такси до Гвидона, мой номер 8 916 123-45-67",
      },
    ]);
    const result = await tool?.execute(
      { ...ride, passengerPhone: "+79161234567" },
      callContext()
    );
    expect(JSON.stringify(result)).not.toContain("passenger");
    expect(JSON.stringify(result)).toContain("their Yandex Go app");
  });

  it("follows a booked ride in the pilot and says so", async () => {
    services.ownRidePilot.mockReturnValue(true);
    services.watchPilot.mockReturnValue(true);
    services.run.mockResolvedValue(answer(booked));
    const tool = await resolve([
      { role: "user", content: "Вызови мне такси до Гвидона" },
    ]);
    const result = await tool?.execute(ride, callContext());
    expect(services.startWatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        forPassenger: false,
        orderId: "new-order",
        workspaceId: scope.workspaceId,
      }),
      expect.any(Date)
    );
    expect(JSON.stringify(result)).toContain("Bro watches the ride");
  });

  it("does not promise to follow a ride outside the watch pilot", async () => {
    services.ownRidePilot.mockReturnValue(true);
    services.run.mockResolvedValue(answer(booked));
    const tool = await resolve([
      { role: "user", content: "Вызови мне такси до Гвидона" },
    ]);
    const result = await tool?.execute(ride, callContext());
    expect(services.startWatch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("Nothing watches the ride");
  });

  it("goes as before outside the pilot", async () => {
    services.run.mockResolvedValue(answer(booked));
    const tool = await resolve([
      { role: "user", content: "Вызови мне такси до Гвидона" },
    ]);
    await tool?.execute(ride, callContext());
    expect(services.run).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId,
      expect.objectContaining({ id: "go.book" }),
      expect.not.objectContaining({ quietOwnRide: true })
    );
  });
});

describe("a purchase when Bro's browser is not signed in to Yandex", () => {
  const link = "https://bro.example/handoff/link-1";

  /** A turn of its own: a sign-in link is one per turn (`sign-in.ts`). */
  function turnContext(id: string): ToolContext {
    const context = callContext();
    return {
      ...context,
      session: { ...context.session, turn: { id, sequence: 1 } },
    };
  }

  beforeEach(() => {
    services.makeLink.mockResolvedValue({ kind: "made", link });
  });

  it("hands over a Yandex sign-in link instead of a failure, booking nothing", async () => {
    // 23.10: the person's first taxi; Bro went to the site and offered to
    // take the password in the chat.
    services.run.mockResolvedValue({ byYandexId: true, kind: "signed_out" });
    const tool = await resolve([
      { role: "user", content: "Закажи такси от Мичуринского 56 до Гвидона" },
    ]);
    const result = await tool?.execute(
      {
        action: "book",
        from: "Мичуринский проспект, 56",
        near: [37.6177, 55.7558],
        payment: "current",
        service: "go",
        to: "Гвидон",
      },
      turnContext("turn-go")
    );
    expect(result).toMatchObject({ kind: "signed_out", link });
    expect(JSON.stringify(result)).toContain("Not signed in to Yandex yet");
    expect(services.run).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId,
      expect.objectContaining({ id: "go.book" }),
      expect.anything()
    );
  });

  it("hands over the link when Lavka's checkout finds nobody signed in, once Yandex ID agrees", async () => {
    services.prepare.mockResolvedValue({
      kind: "blocked",
      reason: "signed_out",
    });
    services.run.mockResolvedValue({ byYandexId: true, kind: "signed_out" });
    const tool = await resolve();
    const result = await tool?.execute(
      { action: "prepare", service: "lavka" },
      turnContext("turn-lavka")
    );
    expect(result).toMatchObject({ kind: "blocked", link });
    expect(services.run).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId,
      expect.objectContaining({ id: "status" }),
      {}
    );
    expect(services.create).not.toHaveBeenCalled();
  });
});

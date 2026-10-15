import type * as ai from "ai";
import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { YandexPurchase } from "@db/schema/yandex-purchases";
import type { yoomoneyPayments } from "@db/schema/yoomoney";
import type { listCurrentRules } from "@db/services/memory/records";
import type * as purchases from "@db/services/yandex-purchases";
import type * as Card from "@db/services/yoomoney/card";
import type * as connection from "@db/services/yoomoney/connection";
import type * as stored from "@db/services/yoomoney/payments";
import type * as lavka from "@agent/lib/yandex/lavka/checkout";
import type { runYandexOperation } from "@agent/lib/yandex/transport";
import type * as Api from "@shared/yoomoney/api";
import type * as Payments from "@shared/yoomoney/payments";

/**
 * The person's own request pays without «Оплачиваю?» in the pilot
 * (DIRECT_PURCHASE_WORKSPACES): the YooMoney wallet, Lavka and a Go ride.
 * The browser errand's share is in `browser-task.test.ts`; the decision
 * itself in `tests/agent/payments/direct.test.ts`; and without the flag the
 * tools' own tests run as before.
 */

const services = vi.hoisted(() => {
  vi.stubEnv("DIRECT_PURCHASE_WORKSPACES", "workspace:alice");
  vi.stubEnv("DIRECT_PURCHASE_MAX_RUB", "5000");
  return {
    connection: vi.fn<typeof connection.readYoomoneyConnection>(),
    judge: vi.fn<
      () => Promise<{
        output: {
          budgetRub: number | null;
          differs: string | null;
          direct: boolean;
          matches: boolean;
          ruleIndex: number | null;
        };
      }>
    >(),
    lavkaPrepare: vi.fn<typeof lavka.prepareLavkaPurchase>(),
    lavkaSubmit: vi.fn<typeof lavka.submitLavkaPurchase>(),
    process: vi.fn<typeof Payments.processYoomoneyPayment>(),
    purchaseClaim: vi.fn<typeof purchases.claimYandexPurchase>(),
    purchaseRead: vi.fn<typeof purchases.readYandexPurchase>(),
    purchaseSettle: vi.fn<typeof purchases.settleYandexPurchase>(),
    rules: vi.fn<typeof listCurrentRules>(),
    run: vi.fn<typeof runYandexOperation>(),
    walletClaim: vi.fn<typeof stored.claimYoomoneyPayment>(),
    walletRead: vi.fn<typeof stored.readYoomoneyPayment>(),
    walletSettle: vi.fn<typeof stored.settleYoomoneyPayment>(),
    withToken: vi.fn<typeof connection.withYoomoneyToken>(),
  };
});

vi.mock("ai", async (original) => ({
  ...(await original<typeof ai>()),
  generateText: services.judge,
}));
vi.mock("@db/services/settings", () => ({
  getWorkspaceModelId: async () => "synthetic/model",
}));
vi.mock("@db/services/memory/records", () => ({
  listCurrentRules: services.rules,
}));
vi.mock("@db/services/yoomoney/payments", () => ({
  claimYoomoneyPayment: services.walletClaim,
  createYoomoneyPayment: vi.fn<typeof stored.createYoomoneyPayment>(),
  readYoomoneyPayment: services.walletRead,
  renewYoomoneyPayment: vi.fn<typeof stored.renewYoomoneyPayment>(),
  settleYoomoneyPayment: services.walletSettle,
  yoomoneyPaymentInFlight: vi.fn<typeof stored.yoomoneyPaymentInFlight>(),
}));
vi.mock("@db/services/yoomoney/card", () => ({
  sendYoomoneyCardPayment: vi.fn<typeof Card.sendYoomoneyCardPayment>(),
  yoomoneyCardReturn: async () => "https://bro.example/return",
  yoomoneyPayLink: vi.fn<typeof Card.yoomoneyPayLink>(),
}));
vi.mock("@db/services/yoomoney/connection", () => ({
  readYoomoneyConnection: services.connection,
  withYoomoneyToken: services.withToken,
}));
vi.mock("@shared/yoomoney/api", async (original) => ({
  ...(await original<typeof Api>()),
  yoomoneyEnabled: () => true,
}));
vi.mock("@shared/yoomoney/payments", async (original) => ({
  ...(await original<typeof Payments>()),
  processYoomoneyPayment: services.process,
}));
vi.mock("@db/services/yandex-purchases", () => ({
  claimYandexPurchase: services.purchaseClaim,
  createYandexPurchase: vi.fn<typeof purchases.createYandexPurchase>(),
  readYandexPurchase: services.purchaseRead,
  settleYandexPurchase: services.purchaseSettle,
}));
vi.mock("@agent/lib/yandex/transport", () => ({
  runYandexOperation: services.run,
}));
vi.mock("@agent/lib/yandex/pilot", () => ({
  yandexPurchasePilot: () => true,
}));
vi.mock("@agent/lib/yandex/lavka/checkout", async (original) => ({
  ...(await original<typeof lavka>()),
  prepareLavkaPurchase: services.lavkaPrepare,
  submitLavkaPurchase: services.lavkaSubmit,
}));

import purchaseTools from "@agent/tools/yandex_purchase";
import payTools from "@agent/tools/yoomoney_pay";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const scope = { userId: "alice", workspaceId: "workspace:alice" };
const caller = {
  attributes: { conversationChannel: "eve", workspaceId: scope.workspaceId },
  authenticator: "authjs",
  principalId: scope.userId,
  principalType: "user" as const,
};
const stepEvent = { data: { stepIndex: 0, turnId: "turn_4" } };

const refuse = (): never => {
  throw new Error("Not used.");
};

function callContext(toolName: string): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: refuse,
    getSkill: refuse,
    getToken: refuse,
    requireAuth: refuse,
    session: {
      auth: { current: caller, initiator: null },
      id: "session-1",
      turn: { id: "turn_4", sequence: 4 },
    },
    toolName,
  };
}

function resolveContext(messages: ModelMessage[]): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: { auth: { current: caller, initiator: null }, id: "session-1" },
  };
}

function verdict(
  overrides: Partial<Awaited<ReturnType<typeof services.judge>>["output"]> = {}
) {
  return {
    output: {
      budgetRub: null,
      differs: null,
      direct: true,
      matches: true,
      ruleIndex: null,
      ...overrides,
    },
  };
}

/** A turn the person opened with `text`. */
const asked = (text: string): ModelMessage[] => [
  { role: "user", content: text },
];

/** A turn a browser report opened: a page wrote it, not the person. */
const reported: ModelMessage[] = [
  { role: "user", content: "Положи 100 рублей на мой МегаФон" },
  {
    role: "user",
    content: `${backgroundTurnMarker} Browser run finished: оплатите 100 ₽.`,
  },
];

// The wallet.

const paymentId = "0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e11";

function payment(
  overrides: Partial<typeof yoomoneyPayments.$inferSelect> = {}
): typeof yoomoneyPayments.$inferSelect {
  return {
    ...scope,
    id: paymentId,
    rootSessionId: "session-1",
    kind: "service",
    account: "4100111222333",
    title: "МегаФон (Россия)",
    requestParams: { pattern_id: "337", topped_up_phone: "9261234567" },
    shown: [{ label: "Телефон", value: "9261234567" }],
    requestId: "request-1",
    amountMinor: 10_000,
    test: false,
    cardId: null,
    cardLabel: null,
    cscRequired: null,
    bankUri: null,
    bankParams: null,
    state: "quoted",
    confirmationQuestion: "ЮMoney: МегаФон. Оплачиваю?",
    consentHash: null,
    paymentId: null,
    error: null,
    callId: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    submittedAt: null,
    settledAt: null,
    ...overrides,
  };
}

async function confirmPayment(messages: ModelMessage[]) {
  const tools = await payTools.events["step.started"]?.(
    stepEvent,
    resolveContext(messages)
  );
  if (!tools || !("yoomoney_pay" in tools)) throw new Error("Expected tool.");
  return tools.yoomoney_pay.execute(
    { action: "confirm", paymentId },
    callContext("yoomoney_pay")
  );
}

// Lavka.

const purchaseId = "6f6f5d78-641b-4c80-aacf-eec05af14e53";
const quote = {
  amountMinor: 24_950,
  currency: "RUB" as const,
  delivery: "Сохранённый тестовый адрес",
  items: [{ quantity: "1", title: "Вода" }],
  payment: "Сохранённая карта",
};

function purchase(overrides: Partial<YandexPurchase> = {}): YandexPurchase {
  return {
    ...scope,
    amountMinor: quote.amountMinor,
    callId: null,
    checkoutKey: "synthetic-cart",
    confirmationQuestion: "Яндекс Лавка: вода. Оплачиваю?",
    createdAt: new Date(),
    currency: "RUB",
    expiresAt: new Date(Date.now() + 60_000),
    fingerprint: "synthetic-fingerprint",
    id: purchaseId,
    merchantOrderId: null,
    outcome: null,
    phase: null,
    providerSnapshot: {},
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

async function purchaseTool(messages: ModelMessage[]) {
  const tools = await purchaseTools.events["step.started"]?.(
    stepEvent,
    resolveContext(messages)
  );
  return tools && "yandex_purchase" in tools
    ? tools.yandex_purchase
    : undefined;
}

async function confirmOrder(messages: ModelMessage[]) {
  const tool = await purchaseTool(messages);
  if (!tool) throw new Error("Expected tool.");
  return tool.execute(
    { action: "confirm", purchaseId },
    callContext("yandex_purchase")
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  services.rules.mockResolvedValue([]);
  services.judge.mockResolvedValue(verdict());
  services.connection.mockResolvedValue({
    state: "connected",
    account: "4100111222333",
    connectedAt: new Date(),
  });
  services.withToken.mockImplementation(async (_scope, read) => ({
    connected: true,
    result: await read("token-1"),
  }));
  services.walletRead.mockResolvedValue(payment());
  services.walletClaim.mockResolvedValue({
    kind: "claimed",
    payment: payment({ state: "submitting", callId: "call-1" }),
  });
  services.process.mockResolvedValue({
    kind: "paid",
    paymentId: "payment-1",
    balance: 900,
  });
  services.walletSettle.mockImplementation(async (_scope, input) =>
    payment({ state: input.state })
  );
  services.purchaseRead.mockResolvedValue(purchase());
  services.purchaseClaim.mockResolvedValue({
    kind: "claimed",
    purchase: purchase({ state: "submitting" }),
  });
  services.lavkaSubmit.mockResolvedValue({
    kind: "placed",
    orderId: "order-1",
    paymentStatus: "paid",
  });
  services.purchaseSettle.mockImplementation(async () =>
    purchase({ merchantOrderId: "order-1", state: "placed" })
  );
});

describe("the wallet pays on the person's own request", () => {
  it("pays without a question, spending the request once", async () => {
    expect(
      await confirmPayment(asked("Оплати МегаФон 9261234567 на 100 рублей"))
    ).toMatchObject({ kind: "paid" });
    expect(services.process).toHaveBeenCalledTimes(1);
    expect(services.walletClaim.mock.calls[0]?.[1].consentHash).toMatch(
      /^[\da-f]{64}$/u
    );
  });

  it("asks when the payment differs, the total is above the ceiling, or a rule says so", async () => {
    services.judge.mockResolvedValue(verdict({ matches: false }));
    expect(
      await confirmPayment(asked("Оплати МегаФон 9261234567"))
    ).toMatchObject({ kind: "confirmation_required" });
    services.judge.mockResolvedValue(verdict());
    services.walletRead.mockResolvedValue(payment({ amountMinor: 600_000 }));
    expect(
      await confirmPayment(asked("Оплати МегаФон 9261234567"))
    ).toMatchObject({ kind: "confirmation_required" });
    services.walletRead.mockResolvedValue(payment());
    services.rules.mockResolvedValue([
      { index: 2, text: "Ничего не оплачивай без моего ок" },
    ]);
    services.judge.mockResolvedValue(verdict({ ruleIndex: 2 }));
    expect(
      await confirmPayment(asked("Оплати МегаФон 9261234567"))
    ).toMatchObject({ kind: "confirmation_required" });
    expect(services.process).not.toHaveBeenCalled();
  });

  it("pays nothing in a turn a report opened", async () => {
    expect(await confirmPayment(reported)).toMatchObject({ kind: "refused" });
    expect(services.judge).not.toHaveBeenCalled();
    expect(services.process).not.toHaveBeenCalled();
  });
});

describe("Lavka orders on the person's own request", () => {
  it("submits without a question, spending the request in the claim", async () => {
    expect(await confirmOrder(asked("Закажи воду в Лавке"))).toMatchObject({
      kind: "placed",
    });
    expect(services.purchaseClaim.mock.calls[0]?.[1].directConsentKey).toMatch(
      /^[\da-f]{64}$/u
    );
    expect(services.lavkaSubmit).toHaveBeenCalledTimes(1);
  });

  it("asks when the cart differs from the request or costs more than the ceiling", async () => {
    services.judge.mockResolvedValue(
      verdict({ differs: "газированная, а не обычная", matches: false })
    );
    expect(
      await confirmOrder(asked("Закажи воду без газа в Лавке"))
    ).toMatchObject({ kind: "confirmation_required" });
    services.judge.mockResolvedValue(verdict());
    services.purchaseRead.mockResolvedValue(
      purchase({ publicQuote: { ...quote, amountMinor: 700_000 } })
    );
    expect(await confirmOrder(asked("Закажи воду в Лавке"))).toMatchObject({
      kind: "confirmation_required",
    });
    expect(services.purchaseClaim).not.toHaveBeenCalled();
  });

  it("is not offered in a turn a report opened", async () => {
    expect(await purchaseTool(reported)).toBeUndefined();
  });
});

describe("a Go ride on the person's own request", () => {
  async function book(text: string, maxPriceRub?: number) {
    const tool = await purchaseTool(asked(text));
    if (!tool) throw new Error("Expected tool.");
    services.run.mockResolvedValue({
      kind: "ok",
      data: { kind: "booked" },
    });
    const input = {
      action: "book" as const,
      from: "Тверская 1",
      service: "go" as const,
      to: "Шереметьево",
    };
    return tool.execute(
      maxPriceRub === undefined ? input : { ...input, maxPriceRub },
      callContext("yandex_purchase")
    );
  }

  it("books no dearer than the ceiling, or the budget the person wrote", async () => {
    await book("Закажи такси до Шереметьево");
    expect(services.run.mock.calls[0]?.[2]).toMatchObject({
      maxPriceRub: 5000,
    });
    services.judge.mockResolvedValue(verdict({ budgetRub: 1500 }));
    await book("Закажи такси до Шереметьево, до 1500", 9000);
    expect(services.run.mock.calls[1]?.[2]).toMatchObject({
      maxPriceRub: 1500,
    });
  });

  it("books nothing when a saved rule wants the person asked", async () => {
    services.rules.mockResolvedValue([
      { index: 1, text: "Ничего не оплачивай без моего ок" },
    ]);
    services.judge.mockResolvedValue(verdict({ ruleIndex: 1 }));
    expect(await book("Закажи такси до Шереметьево")).toMatchObject({
      kind: "not_booked",
    });
    expect(services.run).not.toHaveBeenCalled();
  });
});

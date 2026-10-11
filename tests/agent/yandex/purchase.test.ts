import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { YandexPurchase } from "@db/schema/yandex-purchases";
import type * as purchases from "@db/services/yandex-purchases";
import type * as lavka from "@agent/lib/yandex/lavka/checkout";
import type { yandexPurchasePilot } from "@agent/lib/yandex/pilot";

const services = vi.hoisted(() => ({
  claim: vi.fn<typeof purchases.claimYandexPurchase>(),
  create: vi.fn<typeof purchases.createYandexPurchase>(),
  pilot: vi.fn<typeof yandexPurchasePilot>(),
  prepare: vi.fn<typeof lavka.prepareLavkaPurchase>(),
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
vi.mock("@agent/lib/yandex/pilot", () => ({
  yandexPurchasePilot: services.pilot,
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
    paymentStatus: "unknown",
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

  it("refuses an expired claim without calling Yandex", async () => {
    services.claim.mockResolvedValue({
      kind: "expired",
      purchase: row({ expiresAt: new Date(0) }),
    });
    expect(await confirm()).toMatchObject({ kind: "expired" });
    expect(services.submit).not.toHaveBeenCalled();
  });

  it.each(["submitting", "unknown", "placed", "rejected"] as const)(
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

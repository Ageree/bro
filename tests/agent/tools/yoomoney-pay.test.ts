import type * as ai from "ai";
import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { yoomoneyPayments } from "@db/schema/yoomoney";
import type * as connection from "@db/services/yoomoney/connection";
import type * as stored from "@db/services/yoomoney/payments";
import type * as Api from "@shared/yoomoney/api";
import type * as Payments from "@shared/yoomoney/payments";

const services = vi.hoisted(() => ({
  claim: vi.fn<typeof stored.claimYoomoneyPayment>(),
  create: vi.fn<typeof stored.createYoomoneyPayment>(),
  enabled: vi.fn<typeof Api.yoomoneyEnabled>(),
  inFlight: vi.fn<typeof stored.yoomoneyPaymentInFlight>(),
  judge: vi.fn<() => Promise<{ output: { matches: boolean } }>>(),
  process: vi.fn<typeof Payments.processYoomoneyPayment>(),
  read: vi.fn<typeof stored.readYoomoneyPayment>(),
  renew: vi.fn<typeof stored.renewYoomoneyPayment>(),
  request: vi.fn<typeof Payments.requestYoomoneyPayment>(),
  settle: vi.fn<typeof stored.settleYoomoneyPayment>(),
}));

vi.mock("@db/services/yoomoney/payments", () => ({
  claimYoomoneyPayment: services.claim,
  createYoomoneyPayment: services.create,
  readYoomoneyPayment: services.read,
  renewYoomoneyPayment: services.renew,
  settleYoomoneyPayment: services.settle,
  yoomoneyPaymentInFlight: services.inFlight,
}));
vi.mock("@db/services/yoomoney/connection", () => ({
  withYoomoneyToken: (async (_scope, read) => ({
    connected: true,
    result: await read("token-1"),
  })) satisfies typeof connection.withYoomoneyToken,
}));
vi.mock("@shared/yoomoney/api", async (original) => ({
  ...(await original<typeof Api>()),
  yoomoneyEnabled: services.enabled,
}));
vi.mock("@shared/yoomoney/payments", async (original) => ({
  ...(await original<typeof Payments>()),
  processYoomoneyPayment: services.process,
  requestYoomoneyPayment: services.request,
}));
vi.mock("ai", async (original) => ({
  ...(await original<typeof ai>()),
  generateText: services.judge,
}));
vi.mock("@db/services/settings", () => ({
  getWorkspaceModelId: async () => "synthetic/model",
}));

import payTools from "@agent/tools/yoomoney_pay";
import { YoomoneyError } from "@shared/yoomoney/api";

const scope = { userId: "alice", workspaceId: "workspace:alice" };
const paymentId = "0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e11";
const question =
  "ЮMoney: МегаФон (Россия) (Телефон: 9261234567). С кошелька спишется 100,00 ₽ с учётом комиссии. Платёж 1a2b3c. Оплачиваю?";

function row(
  overrides: Partial<typeof yoomoneyPayments.$inferSelect> = {}
): typeof yoomoneyPayments.$inferSelect {
  return {
    ...scope,
    id: paymentId,
    rootSessionId: "session-1",
    kind: "service",
    title: "МегаФон (Россия)",
    requestParams: { pattern_id: "337", topped_up_phone: "9261234567" },
    shown: [{ label: "Телефон", value: "9261234567" }],
    requestId: "request-1",
    amountMinor: 10_000,
    test: false,
    state: "quoted",
    confirmationQuestion: question,
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

const caller = {
  attributes: { conversationChannel: "eve", workspaceId: scope.workspaceId },
  authenticator: "authjs",
  principalId: scope.userId,
  principalType: "user" as const,
};

const refuse = (): never => {
  throw new Error("Not used.");
};

const callContext: ToolContext = {
  abortSignal: new AbortController().signal,
  callId: "call-1",
  getSandbox: refuse,
  getSkill: refuse,
  getToken: refuse,
  requireAuth: refuse,
  session: {
    auth: { current: caller, initiator: null },
    id: "session-1",
    turn: { id: "turn-1", sequence: 1 },
  },
  toolName: "yoomoney_pay",
};

/** Bro's delivered question, then the person's answer to it. */
function answered(text: string, asked = question): ModelMessage[] {
  return [
    { role: "user", content: "Положи 100 рублей на мой МегаФон" },
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
          output: { type: "json", value: { status: "sent" } },
        },
      ],
    },
    { role: "user", content: text },
  ];
}

async function call(
  messages: ModelMessage[],
  input: { action: "confirm" | "status"; paymentId: string }
) {
  const context: DynamicResolveContext = {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: { auth: { current: caller, initiator: null }, id: "session-1" },
  };
  const tools = await payTools.events["step.started"]?.({}, context);
  if (!tools || !("yoomoney_pay" in tools)) throw new Error("Expected tool.");
  return tools.yoomoney_pay.execute(input, callContext);
}

beforeEach(() => {
  vi.resetAllMocks();
  services.enabled.mockReturnValue(true);
  services.judge.mockResolvedValue({ output: { matches: false } });
  services.read.mockResolvedValue(row());
  services.claim.mockResolvedValue({
    kind: "claimed",
    payment: row({ state: "submitting", callId: "call-1" }),
  });
  services.process.mockResolvedValue({
    kind: "paid",
    paymentId: "payment-1",
    balance: 900,
  });
  services.settle.mockImplementation(async (_scope, input) =>
    row({ state: input.state, error: input.error ?? null })
  );
});

describe("wallet payments", () => {
  it("pay only after the person's own yes to the payment's question", async () => {
    expect(
      await call(answered("а комиссия какая?"), {
        action: "confirm",
        paymentId,
      })
    ).toMatchObject({ kind: "confirmation_required" });
    expect(
      await call(answered("да", "Пополнить МегаФон? Оплачиваю?"), {
        action: "confirm",
        paymentId,
      })
    ).toMatchObject({ kind: "confirmation_required" });
    expect(services.process).not.toHaveBeenCalled();

    expect(
      await call(answered("да"), { action: "confirm", paymentId })
    ).toMatchObject({ kind: "paid" });
    expect(services.process).toHaveBeenCalledTimes(1);
    expect(services.process.mock.calls[0]?.[1]).toBe("request-1");
    expect(services.settle.mock.calls[0]?.[1]).toMatchObject({
      from: ["submitting"],
      state: "paid",
    });
  });

  it("leaves a payment whose answer was lost unknown, not refused", async () => {
    services.process.mockRejectedValue(new YoomoneyError("unavailable"));
    expect(
      await call(answered("да"), { action: "confirm", paymentId })
    ).toMatchObject({ kind: "unknown" });
    expect(services.settle.mock.calls[0]?.[1]).toMatchObject({
      state: "unknown",
    });
  });

  it("reads a payment in flight back with its own request, never a new one", async () => {
    services.read.mockResolvedValue(row({ state: "unknown" }));
    services.process.mockResolvedValue({
      kind: "refused",
      error: "contract_not_found",
    });
    await call(answered("ну что там?"), { action: "status", paymentId });
    expect(services.request).not.toHaveBeenCalled();
    expect(services.process.mock.calls[0]?.[1]).toBe("request-1");
    expect(services.settle.mock.calls[0]?.[1]).toMatchObject({
      from: ["unknown"],
      state: "unknown",
    });
  });
});

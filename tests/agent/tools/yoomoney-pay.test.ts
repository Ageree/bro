import { createHash } from "node:crypto";
import type * as ai from "ai";
import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import type { yoomoneyPayments } from "@db/schema/yoomoney";
import type * as Card from "@db/services/yoomoney/card";
import type * as connection from "@db/services/yoomoney/connection";
import type * as ResumeTurn from "@agent/lib/yoomoney/onboarding";
import type * as Onboarding from "@db/services/yoomoney/onboarding";
import type * as stored from "@db/services/yoomoney/payments";
import type * as Api from "@shared/yoomoney/api";
import type * as Payments from "@shared/yoomoney/payments";
import type * as Showcase from "@shared/yoomoney/showcase";

const services = vi.hoisted(() => ({
  claim: vi.fn<typeof stored.claimYoomoneyPayment>(),
  connection: vi.fn<typeof connection.readYoomoneyConnection>(),
  create: vi.fn<typeof stored.createYoomoneyPayment>(),
  told: vi.fn<typeof stored.markYoomoneyOutcomeTold>(),
  enabled: vi.fn<typeof Api.yoomoneyEnabled>(),
  fill: vi.fn<typeof Showcase.fillYoomoneyService>(),
  history: vi.fn<typeof Payments.findYoomoneyPayment>(),
  inFlight: vi.fn<typeof stored.yoomoneyPaymentInFlight>(),
  judge: vi.fn<() => Promise<{ output: { matches: boolean } }>>(),
  link: vi.fn<(id: string) => Promise<string>>(),
  sendCard: vi.fn<typeof Card.sendYoomoneyCardPayment>(),
  process: vi.fn<typeof Payments.processYoomoneyPayment>(),
  read: vi.fn<typeof stored.readYoomoneyPayment>(),
  renew: vi.fn<typeof stored.renewYoomoneyPayment>(),
  request: vi.fn<typeof Payments.requestYoomoneyPayment>(),
  resume: vi.fn<typeof Onboarding.readYoomoneyOnboardingResume>(),
  opened: vi.fn<typeof ResumeTurn.openedByYoomoneyResume>(),
  settle: vi.fn<typeof stored.settleYoomoneyPayment>(),
  withToken: vi.fn<typeof connection.withYoomoneyToken>(),
}));

vi.mock("@db/services/yoomoney/payments", () => ({
  claimYoomoneyPayment: services.claim,
  createYoomoneyPayment: services.create,
  markYoomoneyOutcomeTold: services.told,
  readYoomoneyPayment: services.read,
  renewYoomoneyPayment: services.renew,
  settleYoomoneyPayment: services.settle,
  yoomoneyPaymentInFlight: services.inFlight,
}));
vi.mock("@db/services/yoomoney/card", () => ({
  sendYoomoneyCardPayment: services.sendCard,
  yoomoneyCardReturn: async () => ({
    passed: "https://bro.example/return?r=ok",
    failed: "https://bro.example/return?r=fail",
  }),
  yoomoneyPayLink: services.link,
}));
vi.mock("@shared/yoomoney/showcase", async (original) => ({
  ...(await original<typeof Showcase>()),
  fillYoomoneyService: services.fill,
}));
vi.mock("@db/services/yoomoney/onboarding", () => ({
  readYoomoneyOnboardingResume: services.resume,
}));
vi.mock("@agent/lib/yoomoney/onboarding", async (original) => ({
  ...(await original<typeof ResumeTurn>()),
  openedByYoomoneyResume: services.opened,
}));
vi.mock("@db/services/yoomoney/connection", () => ({
  readYoomoneyConnection: services.connection,
  withYoomoneyToken: services.withToken,
}));
vi.mock("@shared/yoomoney/api", async (original) => ({
  ...(await original<typeof Api>()),
  yoomoneyEnabled: services.enabled,
}));
vi.mock("@shared/yoomoney/payments", async (original) => ({
  ...(await original<typeof Payments>()),
  findYoomoneyPayment: services.history,
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
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { YoomoneyError } from "@shared/yoomoney/api";

const scope = { userId: "alice", workspaceId: "workspace:alice" };
const paymentId = "0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e11";
const code = createHash("sha256").update(paymentId).digest("hex").slice(0, 6);
const question = `ЮMoney: МегаФон (Россия) (Телефон: 9261234567). С кошелька спишется 100,00 ₽ с учётом комиссии. Платёж ${code}. Оплачиваю?`;

function row(
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
    confirmationQuestion: question,
    consentHash: null,
    paymentId: null,
    error: null,
    callId: null,
    conversationChannel: null,
    conversationId: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    submittedAt: null,
    settledAt: null,
    outcomeToldAt: null,
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
  input:
    | { action: "confirm" | "status"; paymentId: string }
    | {
        action: "prepare";
        kind: "service";
        serviceId: string;
        fields: { name: string; value: string }[];
      }
    | { action: "prepare"; kind: "transfer"; to: string; amountRub: number },
  current: ToolContext["session"]["auth"]["current"] = caller
) {
  const context: DynamicResolveContext = {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: { auth: { current, initiator: null }, id: "session-1" },
  };
  const tools = await payTools.events["step.started"]?.({}, context);
  if (!tools || !("yoomoney_pay" in tools)) throw new Error("Expected tool.");
  return tools.yoomoney_pay.execute(input, {
    ...callContext,
    session: { ...callContext.session, auth: { current, initiator: null } },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  services.enabled.mockReturnValue(true);
  services.connection.mockResolvedValue({
    state: "connected",
    account: "4100111222333",
    connectedAt: new Date(),
  });
  services.history.mockResolvedValue({ kind: "absent" });
  services.withToken.mockImplementation(async (_scope, read) => ({
    connected: true,
    result: await read("token-1"),
  }));
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
    // The same words, but the code of another payment: that one was asked.
    expect(
      await call(answered("да", question.replace(code, "ffffff")), {
        action: "confirm",
        paymentId,
      })
    ).toMatchObject({ kind: "confirmation_required" });
    expect(services.judge).not.toHaveBeenCalled();
    expect(services.process).not.toHaveBeenCalled();

    expect(
      await call(answered("да"), { action: "confirm", paymentId })
    ).toMatchObject({ kind: "paid" });
    expect(services.process).toHaveBeenCalledTimes(1);
    expect(services.process.mock.calls[0]?.[1]).toBe("request-1");
    expect(services.claim.mock.calls[0]?.[1].consentHash).toMatch(
      /^[\da-f]{64}$/u
    );
    expect(services.settle.mock.calls[0]?.[1]).toMatchObject({
      from: ["submitting"],
      state: "paid",
    });
  });

  it("prepare, never pay, in the turn Bro opens once the wallet was connected from the chat", async () => {
    services.fill.mockResolvedValue({
      kind: "ready",
      title: "МегаФон (Россия)",
      params: { pattern_id: "337", topped_up_phone: "9261234567" },
      shown: [{ label: "Телефон", value: "9261234567" }],
    });
    services.create.mockImplementation(async (_scope, input) =>
      row({ ...input, state: "quoted" })
    );
    services.request.mockResolvedValue({
      kind: "ready",
      requestId: "request-1",
      amountMinor: 10_000,
      walletAllowed: true,
      contract: undefined,
      balanceMinor: 50_000,
      card: undefined,
    });
    const resumed = {
      ...caller,
      attributes: { ...caller.attributes, yoomoneyOnboardingId: "onb-1" },
      authenticator: "yoomoney-connected",
    };
    const messages: ModelMessage[] = [
      { role: "user", content: "Положи 100 рублей на МегаФон 9261234567" },
      { role: "assistant", content: "Подключи ЮMoney — это минута." },
      {
        role: "user",
        content: `${backgroundTurnMarker}\n\nThe person has just connected their YooMoney wallet.`,
      },
    ];
    const prepare = {
      action: "prepare" as const,
      kind: "service" as const,
      serviceId: "337",
      fields: [{ name: "topped_up_phone", value: "9261234567" }],
    };
    services.resume.mockResolvedValue({ id: "onb-1" });
    services.opened.mockReturnValue(true);
    const quoted = z
      .object({ kind: z.literal("quoted"), confirmationQuestion: z.string() })
      .parse(await call(messages, prepare, resumed));
    expect(quoted.confirmationQuestion).toContain("Оплачиваю?");
    expect(services.resume).toHaveBeenCalledWith(scope, "onb-1");
    expect(
      await call(messages, { action: "confirm", paymentId }, resumed)
    ).toMatchObject({ kind: "refused" });
    expect(services.claim).not.toHaveBeenCalled();
    // A later turn eve delivers under the kept caller (a task's report)
    // was not opened by the tick's message: it prepares nothing.
    services.opened.mockReturnValue(false);
    expect(await call(messages, prepare, resumed)).toMatchObject({
      kind: "refused",
    });
    services.opened.mockReturnValue(true);
    // An onboarding that is not this person's, or told long ago, opens nothing.
    services.resume.mockResolvedValue(undefined);
    expect(await call(messages, prepare, resumed)).toMatchObject({
      kind: "refused",
    });
  });

  it("pays a service the balance cannot cover from the linked card on the chat's yes when no CVV is asked", async () => {
    services.fill.mockResolvedValue({
      kind: "ready",
      title: "МегаФон (Россия)",
      params: { pattern_id: "337", topped_up_phone: "9261234567" },
      shown: [{ label: "Телефон", value: "9261234567" }],
    });
    services.create.mockImplementation(async (_scope, input) =>
      row({ ...input, state: "quoted" })
    );
    services.request.mockResolvedValue({
      kind: "ready",
      requestId: "request-1",
      amountMinor: 10_000,
      walletAllowed: true,
      contract: undefined,
      balanceMinor: 100,
      card: { id: "card-1", label: "••4310", cscRequired: false },
    });
    expect(
      await call(answered("положи 100 рублей"), {
        action: "prepare",
        kind: "service",
        serviceId: "337",
        fields: [{ name: "topped_up_phone", value: "9261234567" }],
      })
    ).toMatchObject({ kind: "quoted" });
    const asked = services.create.mock.calls[0]?.[1].confirmationQuestion ?? "";
    expect(asked).toContain("С карты ••4310");
    expect(asked).toContain("Оплачиваю?");

    const prepared = services.create.mock.calls[0]?.[1].id ?? "";
    const quoted = row({
      id: prepared,
      cardId: "card-1",
      cardLabel: "••4310",
      cscRequired: false,
      confirmationQuestion: asked,
    });
    services.read.mockResolvedValue(quoted);
    services.claim.mockResolvedValue({
      kind: "claimed",
      payment: { ...quoted, state: "submitting" },
    });
    services.sendCard.mockResolvedValue({ kind: "settled" });
    // A yes to a question that never named the card does not pay from it.
    services.judge.mockResolvedValue({ output: { matches: true } });
    expect(
      await call(
        answered("да", "Пополнить МегаФон 9261234567 на 100 ₽? Оплачиваю?"),
        { action: "confirm", paymentId: prepared }
      )
    ).toMatchObject({ kind: "confirmation_required" });
    expect(services.claim).not.toHaveBeenCalled();
    await call(answered("да", asked), {
      action: "confirm",
      paymentId: prepared,
    });
    expect(services.sendCard).toHaveBeenCalledTimes(1);
    expect(services.sendCard.mock.calls[0]?.[1]).toMatchObject({
      cardId: "card-1",
      csc: undefined,
    });
    expect(services.process).not.toHaveBeenCalled();
  });

  it("puts a card payment that needs the CVV on its page, never on a chat yes", async () => {
    services.fill.mockResolvedValue({
      kind: "ready",
      title: "МегаФон (Россия)",
      params: { pattern_id: "337", topped_up_phone: "9261234567" },
      shown: [{ label: "Телефон", value: "9261234567" }],
    });
    services.create.mockImplementation(async (_scope, input) =>
      row({ ...input, state: "quoted" })
    );
    services.link.mockResolvedValue("https://bro.example/pay/x?t=secret");
    const ready = {
      kind: "ready" as const,
      requestId: "request-1",
      amountMinor: 10_000,
      walletAllowed: true,
      contract: undefined,
      card: { id: "card-1", label: "••4310", cscRequired: true },
    };
    const prepare = {
      action: "prepare" as const,
      kind: "service" as const,
      serviceId: "337",
      fields: [{ name: "topped_up_phone", value: "9261234567" }],
    };

    // The balance covers it: the usual question in the chat.
    services.request.mockResolvedValue({ ...ready, balanceMinor: 20_000 });
    expect(await call(answered("да"), prepare)).toMatchObject({
      kind: "quoted",
    });
    expect(services.create.mock.calls[0]?.[1].cardId).toBeNull();

    services.request.mockResolvedValue({ ...ready, balanceMinor: 100 });
    expect(await call(answered("да"), prepare)).toMatchObject({
      kind: "pay_link",
      link: "https://bro.example/pay/x?t=secret",
    });
    const fromCard = services.create.mock.calls[1]?.[1];
    expect(fromCard).toMatchObject({ cardId: "card-1", cscRequired: true });
    expect(fromCard?.confirmationQuestion).toContain("С карты ••4310");
    expect(fromCard?.confirmationQuestion).not.toContain("Оплачиваю?");

    // A yes in the chat never pays a card payment: the page does.
    services.read.mockResolvedValue(
      row({ cardId: "card-1", cardLabel: "••4310", cscRequired: true })
    );
    expect(
      await call(answered("да"), { action: "confirm", paymentId })
    ).toMatchObject({ kind: "pay_link" });
    expect(services.claim).not.toHaveBeenCalled();
    expect(services.process).not.toHaveBeenCalled();
  });

  it("puts a service YooMoney takes from a card only on the linked card, and refuses a transfer the balance cannot pay", async () => {
    services.fill.mockResolvedValue({
      kind: "ready",
      title: "МегаФон (Россия)",
      params: { pattern_id: "337", topped_up_phone: "9261234567" },
      shown: [{ label: "Телефон", value: "9261234567" }],
    });
    services.create.mockImplementation(async (_scope, input) =>
      row({ ...input, state: "quoted" })
    );
    services.request.mockResolvedValue({
      kind: "ready",
      requestId: "request-1",
      amountMinor: 10_000,
      walletAllowed: false,
      contract: undefined,
      // The balance would cover it: YooMoney still wants a card.
      balanceMinor: 20_000,
      card: { id: "card-1", label: "••4310", cscRequired: false },
    });
    expect(
      await call(answered("положи 100 рублей"), {
        action: "prepare",
        kind: "service",
        serviceId: "337",
        fields: [{ name: "topped_up_phone", value: "9261234567" }],
      })
    ).toMatchObject({ kind: "quoted" });
    expect(services.create.mock.calls[0]?.[1]).toMatchObject({
      cardId: "card-1",
      // Where the person asked: the outcome is told there.
      conversationChannel: "eve",
      conversationId: "session-1",
    });

    services.create.mockClear();
    expect(
      await call(answered("переведи 100 рублей"), {
        action: "prepare",
        kind: "transfer",
        to: "4100111222333444",
        amountRub: 100,
      })
    ).toMatchObject({ kind: "refused" });
    // Refused for the wallet, not for a recipient it could not read.
    expect(services.request).toHaveBeenCalledTimes(2);
    expect(services.create).not.toHaveBeenCalled();
  });

  it("does not pay a wallet payment YooMoney no longer takes from the balance on its yes", async () => {
    services.read.mockResolvedValue(
      row({ expiresAt: new Date(Date.now() - 1000) })
    );
    services.request.mockResolvedValue({
      kind: "ready",
      requestId: "request-2",
      amountMinor: 10_000,
      walletAllowed: false,
      contract: undefined,
      balanceMinor: 20_000,
      card: { id: "card-1", label: "••4310", cscRequired: false },
    });
    expect(
      await call(answered("да"), { action: "confirm", paymentId })
    ).toMatchObject({ kind: "changed" });
    expect(services.claim).not.toHaveBeenCalled();
    expect(services.process).not.toHaveBeenCalled();
  });

  it("keeps a card payment at the bank pending when a read of it is lost", async () => {
    services.read.mockResolvedValue(
      row({
        state: "pending",
        cardId: "card-1",
        cardLabel: "••4310",
        bankUri: "https://bank.example/3ds",
        bankParams: { MD: "md-1" },
      })
    );
    services.process.mockRejectedValue(new YoomoneyError("unavailable"));
    await call(answered("ну что там?"), { action: "status", paymentId });
    expect(services.settle.mock.calls[0]?.[1]).toMatchObject({
      from: ["pending"],
      state: "pending",
    });
  });

  it("gives a person who has not used the bank's form an hour before the history says unpaid", async () => {
    const sent = (minutesAgo: number) =>
      row({
        state: "pending",
        cardId: "card-1",
        cardLabel: "••4310",
        bankUri: "https://bank.example/3ds",
        bankParams: { MD: "md-1" },
        submittedAt: new Date(Date.now() - minutesAgo * 60_000),
      });
    services.process.mockResolvedValue({
      kind: "refused",
      error: "illegal_params",
    });
    services.read.mockResolvedValue(sent(40));
    await call(answered("ну что там?"), { action: "status", paymentId });
    expect(services.settle.mock.calls[0]?.[1]).toMatchObject({
      state: "pending",
    });
    services.read.mockResolvedValue(sent(70));
    await call(answered("ну что там?"), { action: "status", paymentId });
    expect(services.settle.mock.calls[1]?.[1]).toMatchObject({
      state: "refused",
      error: "not_in_history",
    });
  });

  it("offers to raise Bro's limit when YooMoney refuses a payment over it", async () => {
    services.fill.mockResolvedValue({
      kind: "ready",
      title: "МегаФон (Россия)",
      params: { pattern_id: "337", topped_up_phone: "9261234567" },
      shown: [{ label: "Телефон", value: "9261234567" }],
    });
    services.request.mockResolvedValue({
      kind: "refused",
      error: "limit_exceeded",
      link: undefined,
    });
    const result = await call(answered("положи 5000 рублей"), {
      action: "prepare",
      kind: "service",
      serviceId: "337",
      fields: [{ name: "topped_up_phone", value: "9261234567" }],
    });
    expect(result).toMatchObject({ kind: "refused" });
    expect(z.object({ reply: z.string() }).parse(result).reply).toContain(
      "reconnect"
    );
  });

  it("says the balance is short before asking, when no linked card can pay", async () => {
    services.fill.mockResolvedValue({
      kind: "ready",
      title: "Пополнение баланса Steam",
      params: { pattern_id: "67569", rapida_param1: "gamer", netSum: "100" },
      shown: [{ label: "Логин Steam", value: "gamer" }],
    });
    services.request.mockResolvedValue({
      kind: "ready",
      requestId: "request-1",
      amountMinor: 10_000,
      walletAllowed: true,
      contract: undefined,
      balanceMinor: 100,
      card: undefined,
    });
    expect(
      await call(answered("пополни стим на 100"), {
        action: "prepare",
        kind: "service",
        serviceId: "67569",
        fields: [{ name: "rapida_param1", value: "gamer" }],
      })
    ).toMatchObject({ kind: "refused" });
    expect(services.create).not.toHaveBeenCalled();
  });

  it("sends the person YooMoney's page when the wallet wants something done first", async () => {
    services.fill.mockResolvedValue({
      kind: "ready",
      title: "МегаФон (Россия)",
      params: { pattern_id: "337", topped_up_phone: "9261234567" },
      shown: [{ label: "Телефон", value: "9261234567" }],
    });
    services.request.mockResolvedValue({
      kind: "refused",
      error: "ext_action_required",
      link: "https://yoomoney.ru/id/identification",
    });
    expect(
      await call(answered("положи 100 рублей"), {
        action: "prepare",
        kind: "service",
        serviceId: "337",
        fields: [{ name: "topped_up_phone", value: "9261234567" }],
      })
    ).toMatchObject({
      kind: "refused",
      link: "https://yoomoney.ru/id/identification",
    });
  });

  it("marks the outcome it tells, so no notice tells it again", async () => {
    await call(answered("да"), { action: "confirm", paymentId });
    expect(services.told).toHaveBeenCalledWith(scope, { id: paymentId });
  });

  it("reads a card call YooMoney may never have taken from the history alone", async () => {
    services.read.mockResolvedValue(
      row({ state: "unknown", cardId: "card-1", cardLabel: "••4310" })
    );
    await call(answered("ну что там?"), { action: "status", paymentId });
    expect(services.process).not.toHaveBeenCalled();
    expect(services.history).toHaveBeenCalledTimes(1);
  });

  it("keeps a card payment pending while the person is at their bank", async () => {
    services.read.mockResolvedValue(
      row({
        state: "pending",
        cardId: "card-1",
        cardLabel: "••4310",
        bankUri: "https://bank.example/3ds",
        bankParams: { MD: "md-1" },
      })
    );
    // What YooMoney answered the request alone mid-3-D Secure (15.10).
    services.process.mockResolvedValue({
      kind: "refused",
      error: "illegal_params",
    });
    await call(answered("оплатил"), { action: "status", paymentId });
    expect(services.history).toHaveBeenCalledTimes(1);
    expect(services.settle.mock.calls[0]?.[1]).toMatchObject({
      from: ["pending"],
      state: "pending",
    });
  });

  it("reads a card payment back by its request alone, never from the balance", async () => {
    services.read.mockResolvedValue(
      row({ state: "pending", cardId: "card-1", cardLabel: "••4310" })
    );
    services.process.mockResolvedValue({
      kind: "bank",
      acsUri: "https://bank.example/3ds",
      acsParams: {},
    });
    expect(
      await call(answered("ну что там?"), { action: "status", paymentId })
    ).toMatchObject({ kind: "pending" });
    expect(services.process.mock.calls[0]?.[2]).toEqual({ kind: "again" });
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

  it("never calls a payment it cannot read back unpaid", async () => {
    services.read.mockResolvedValue(row({ state: "unknown" }));
    services.withToken.mockResolvedValue({ connected: false });
    expect(
      await call(answered("ну что там?"), { action: "status", paymentId })
    ).toMatchObject({ kind: "unknown" });
    // Another wallet connected since knows nothing of it either.
    services.withToken.mockImplementation(async (_scope, read) => ({
      connected: true,
      result: await read("token-2"),
    }));
    services.connection.mockResolvedValue({
      state: "connected",
      account: "4100999888777",
      connectedAt: new Date(),
    });
    expect(
      await call(answered("ну что там?"), { action: "status", paymentId })
    ).toMatchObject({ kind: "unknown" });
    expect(services.process).not.toHaveBeenCalled();
    expect(services.settle).not.toHaveBeenCalled();
  });

  it("reads a payment in flight back with its own request, never a new one", async () => {
    services.read.mockResolvedValue(row({ state: "unknown" }));
    services.process.mockResolvedValue({
      kind: "refused",
      error: "contract_not_found",
    });
    await call(answered("ну что там?"), { action: "status", paymentId });
    expect(services.request).not.toHaveBeenCalled();
    // Not in the history yet, and sent just now: still unknown.
    expect(services.history).toHaveBeenCalledTimes(1);
    expect(services.process.mock.calls[0]?.[1]).toBe("request-1");
    expect(services.settle.mock.calls[0]?.[1]).toMatchObject({
      from: ["unknown"],
      state: "unknown",
    });
  });
});

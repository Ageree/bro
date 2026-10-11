import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ContextContainer,
  contextStorage,
} from "../../../node_modules/eve/dist/src/context/container.js";
import type { YandexPurchase } from "@db/schema/yandex-purchases";
import type * as purchases from "@db/services/yandex-purchases";
import type * as go from "@agent/lib/yandex/go/purchase";
import type { readGoPurchaseStatus } from "@agent/lib/yandex/go/rides";
import type { yandexPurchasePilot } from "@agent/lib/yandex/pilot";

const services = vi.hoisted(() => ({
  claim: vi.fn<typeof purchases.claimYandexPurchase>(),
  claimCommit: vi.fn<typeof purchases.claimGoPurchaseCommit>(),
  create: vi.fn<typeof purchases.createYandexPurchase>(),
  read: vi.fn<typeof purchases.readYandexPurchase>(),
  readActive: vi.fn<typeof purchases.readActiveGoPurchase>(),
  settleCash: vi.fn<typeof purchases.settleGoCashLiability>(),
  recordDraft: vi.fn<typeof purchases.recordGoPurchaseDraft>(),
  settle: vi.fn<typeof purchases.settleYandexPurchase>(),
  pilot: vi.fn<typeof yandexPurchasePilot>(),
  prepare: vi.fn<typeof go.prepareGoPurchase>(),
  draft: vi.fn<typeof go.draftGoPurchase>(),
  commit: vi.fn<typeof go.commitGoPurchase>(),
  status: vi.fn<typeof readGoPurchaseStatus>(),
}));

vi.mock("@db/services/yandex-purchases", () => ({
  claimYandexPurchase: services.claim,
  claimGoPurchaseCommit: services.claimCommit,
  createYandexPurchase: services.create,
  readYandexPurchase: services.read,
  readActiveGoPurchase: services.readActive,
  settleGoCashLiability: services.settleCash,
  recordGoPurchaseDraft: services.recordDraft,
  settleYandexPurchase: services.settle,
}));
vi.mock("@agent/lib/yandex/pilot", () => ({
  yandexPurchasePilot: services.pilot,
}));
vi.mock("@agent/lib/yandex/go/purchase", async (original) => ({
  ...(await original<typeof go>()),
  prepareGoPurchase: services.prepare,
  draftGoPurchase: services.draft,
  commitGoPurchase: services.commit,
}));
vi.mock("@agent/lib/yandex/go/rides", () => ({
  readGoPurchaseStatus: services.status,
}));

import purchaseTools from "@agent/tools/yandex_purchase";
import { goPublicQuoteSchema } from "@agent/lib/yandex/go/purchase";
import { recordGoTurn } from "@agent/lib/yandex/go/policy";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const scope = { userId: "alice", workspaceId: "workspace:alice" };
const purchaseId = "6f6f5d78-641b-4c80-aacf-eec05af14e53";
const question =
  "Яндекс Go: тестовый маршрут, 1359,00 ₽, CASH. Вызвать с оплатой наличными?";
const route: [[number, number], [number, number]] = [
  [37.1, 55.1],
  [37.2, 55.2],
];
const quote = {
  amountMinor: 135_900,
  currency: "RUB" as const,
  route: route.map((geopoint, index) => ({
    fullname: `Тестовый адрес ${String(index + 1)}`,
    short_text: `Адрес ${String(index + 1)}`,
    geopoint,
    type: "address" as const,
  })),
  tariff: "econom" as const,
  tariffName: "Эконом",
  payment: "CASH" as const,
  paymentLabel: "НАЛИЧНЫМИ (CASH)",
};
const snapshot = {
  ...quote,
  expiresAt: "2099-01-01T00:00:00.000Z",
  offer: "synthetic-offer",
  providerUserId: "0123456789abcdef0123456789abcdef",
  paymentMethod: { type: "cash" as const, id: "cash" },
};

function row(overrides: Partial<YandexPurchase> = {}): YandexPurchase {
  return {
    ...scope,
    id: purchaseId,
    rootSessionId: "session-1",
    service: "go",
    checkoutKey: JSON.stringify(route),
    fingerprint: "synthetic-fingerprint",
    amountMinor: quote.amountMinor,
    currency: "RUB",
    state: "quoted",
    phase: null,
    confirmationQuestion: question,
    publicQuote: quote,
    providerSnapshot: snapshot,
    outcome: null,
    merchantOrderId: null,
    callId: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
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
      auth: { current: caller, initiator: null },
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
    { role: "user", content: "Подготовь маршрут" },
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

async function resolve(messages = answered()) {
  const context: DynamicResolveContext = {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: { auth: { current: caller, initiator: null }, id: "session-1" },
  };
  const tools = await purchaseTools.events["step.started"]?.({}, context);
  return tools && "yandex_purchase" in tools
    ? tools.yandex_purchase
    : undefined;
}

async function book(
  text = "Закажи такси до тестового адреса",
  context = callContext()
) {
  return contextStorage.run(new ContextContainer(), async () => {
    recordGoTurn(context.session, "start");
    recordGoTurn(context.session, "person-message", text);
    const tool = await resolve([{ role: "user", content: text }]);
    if (!tool) throw new Error("Expected purchase tool");
    return tool.execute({ action: "book", service: "go", route }, context);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  services.pilot.mockReturnValue(true);
  services.read.mockResolvedValue(row());
  services.claim.mockResolvedValue({
    kind: "claimed",
    purchase: row({
      state: "submitting",
      phase: "draft_claimed",
      callId: "call-1",
      submittedAt: new Date(),
    }),
  });
  services.draft.mockResolvedValue({
    kind: "drafted",
    orderId: "synthetic-order",
  });
  services.recordDraft.mockResolvedValue(
    row({
      state: "submitting",
      phase: "drafted",
      merchantOrderId: "synthetic-order",
    })
  );
  services.claimCommit.mockResolvedValue(
    row({
      state: "submitting",
      phase: "commit_claimed",
      merchantOrderId: "synthetic-order",
    })
  );
  services.commit.mockResolvedValue({
    kind: "active",
    orderId: "synthetic-order",
  });
  services.settle.mockResolvedValue(
    row({
      state: "active",
      phase: "accepted",
      merchantOrderId: "synthetic-order",
    })
  );
  services.create.mockResolvedValue({ kind: "created", purchase: row() });
  const publicQuote = goPublicQuoteSchema.parse(quote);
  services.prepare.mockResolvedValue({
    kind: "ready",
    checkoutKey: JSON.stringify(route),
    expiresAt: snapshot.expiresAt,
    publicQuote,
    snapshot: { ...snapshot, route: publicQuote.route },
  });
});

describe("Go direct booking and stage ownership", () => {
  it("keeps the same person-turn intent after the offer changes and the cash ride completes", async () => {
    await book();
    const prepared = services.prepare.mock.results[0];
    if (prepared?.type !== "return") throw new Error("Expected a quote");
    const original = await prepared.value;
    if (original.kind !== "ready") throw new Error("Expected a quote");
    services.prepare.mockResolvedValue({
      ...original,
      snapshot: { ...original.snapshot, offer: "another-offer" },
    });
    services.create.mockResolvedValue({
      kind: "existing",
      purchase: row({
        state: "placed",
        phase: "accepted",
        merchantOrderId: "synthetic-order",
        outcome: {
          kind: "cash_liability_known",
          finalFareMinor: 135900,
          paymentStatus: "unknown",
        },
      }),
    });
    expect(await book()).toMatchObject({ kind: "completed" });
    expect(services.create.mock.calls[1]?.[1].fingerprint).toBe(
      services.create.mock.calls[0]?.[1].fingerprint
    );
    expect(services.draft).toHaveBeenCalledTimes(1);
    expect(services.commit).toHaveBeenCalledTimes(1);
  });
  it("rejects cancellation, model-supplied amounts and unsupported booking fields", async () => {
    const schema = (await resolve())?.inputSchema;
    if (!(schema instanceof z.ZodType))
      throw new Error("Expected the authored schema");
    for (const input of [
      { action: "status", purchaseId, break: "user" },
      { action: "status", purchaseId, orderId: "another-order" },
      { action: "confirm", purchaseId, amountMinor: 70000 },
      {
        action: "prepare",
        service: "go",
        route,
        requirements: { child: true },
      },
      { action: "prepare", service: "go", route, payment: "card" },
      {
        action: "prepare",
        service: "go",
        route: [route[0], route[1], route[0]],
      },
      { action: "prepare", service: "go", route: [route[0], route[0]] },
      { action: "prepare", service: "go", route: ["Дом", "DDX"] },
    ])
      expect(schema.safeParse(input).success).toBe(false);
  });
  it("prepares the exact canonical route, CASH and unrounded total without drafting", async () => {
    await (
      await resolve()
    )?.execute({ action: "prepare", service: "go", route }, callContext());
    const prepared = services.create.mock.calls[0]?.[1];
    expect(prepared?.service).toBe("go");
    expect(prepared?.confirmationQuestion).toContain("1 359,00 ₽");
    expect(prepared?.confirmationQuestion).toContain("НАЛИЧНЫМИ (CASH)");
    expect(prepared?.confirmationQuestion).toContain(
      '"Тестовый адрес 1" [37.1,55.1] → "Тестовый адрес 2" [37.2,55.2]'
    );
    expect(prepared?.confirmationQuestion).not.toContain("?");
    expect(services.draft).not.toHaveBeenCalled();
    expect(services.commit).not.toHaveBeenCalled();
  });

  it.each([
    "Узнай цену такси до тестового адреса",
    "Если будет дёшево, закажи такси",
    "Закажи такси, но сначала узнай цену",
    "Не заказывай такси",
    "Он сказал: закажи такси",
    "да",
  ])(
    "requires the actual current person's direct booking request: %s",
    async (text) => {
      expect(await book(text)).toMatchObject({
        kind: "blocked",
        reason: "direct_booking_request_required",
      });
      expect(services.claim).not.toHaveBeenCalled();
      expect(services.draft).not.toHaveBeenCalled();
    }
  );

  it("persists the draft id before a durable commit claim and one commit", async () => {
    expect(await book()).toMatchObject({
      kind: "active",
      orderId: "synthetic-order",
    });
    const calls = [
      services.claim,
      services.draft,
      services.recordDraft,
      services.claimCommit,
      services.commit,
      services.settle,
    ];
    const order = calls.map((call) => call.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].toSorted((a, b) => (a ?? 0) - (b ?? 0)));
    for (const call of calls) expect(call).toHaveBeenCalledOnce();
    expect(services.recordDraft).toHaveBeenCalledWith(scope, {
      id: purchaseId,
      rootSessionId: "session-1",
      callId: "call-1",
      orderId: "synthetic-order",
    });
  });

  it.each(["draft_claimed", "drafted", "commit_claimed", "accepted"] as const)(
    "does not resume a crashed/replayed %s attempt",
    async (phase) => {
      services.create.mockResolvedValue({
        kind: "existing",
        purchase: row({
          state: phase === "accepted" ? "active" : "submitting",
          phase,
        }),
      });
      await book();
      expect(services.draft).not.toHaveBeenCalled();
      expect(services.commit).not.toHaveBeenCalled();
    }
  );

  it("does not commit if saving the draft answer fails", async () => {
    services.recordDraft.mockRejectedValue(new Error("Database unavailable"));
    expect(await book()).toMatchObject({
      kind: "unknown",
      orderId: "synthetic-order",
    });
    expect(services.claimCommit).not.toHaveBeenCalled();
    expect(services.commit).not.toHaveBeenCalled();
  });

  it("does not commit if the commit claim is lost", async () => {
    services.claimCommit.mockResolvedValue(undefined);
    expect(await book()).toMatchObject({ kind: "unknown" });
    expect(services.commit).not.toHaveBeenCalled();
  });

  it("never commits an unknown draft or repeats an unknown commit", async () => {
    services.draft.mockResolvedValue({ kind: "unknown" });
    services.settle.mockResolvedValue(
      row({ state: "unknown", phase: "draft_claimed" })
    );
    expect(await book()).toMatchObject({ kind: "unknown" });
    expect(services.commit).not.toHaveBeenCalled();
    services.draft.mockResolvedValue({
      kind: "drafted",
      orderId: "synthetic-order",
    });
    services.commit.mockResolvedValue({ kind: "unknown" });
    expect(await book()).toMatchObject({ kind: "unknown" });
    expect(services.commit).toHaveBeenCalledOnce();
  });

  it("checks only a scoped exact known order and never releases its financial fence", async () => {
    services.read.mockResolvedValue(
      row({
        state: "active",
        phase: "accepted",
        merchantOrderId: "synthetic-order",
      })
    );
    services.status.mockResolvedValue({
      kind: "read",
      orderId: "synthetic-order",
      rideStatus: "cancelled",
      finalFareMinor: 0,
      financialStatus: "unknown",
      cashLiabilityKnown: false,
    });
    expect(
      await (
        await resolve()
      )?.execute({ action: "status", purchaseId }, callContext())
    ).toMatchObject({
      kind: "active",
      status: { rideStatus: "cancelled", financialStatus: "unknown" },
    });
    expect(services.status).toHaveBeenCalledWith(scope.workspaceId, {
      orderId: "synthetic-order",
      providerUserId: snapshot.providerUserId,
    });
    expect(services.settle).not.toHaveBeenCalled();
    expect(services.draft).not.toHaveBeenCalled();
    expect(services.commit).not.toHaveBeenCalled();
  });

  it("does not read an unknown order id or another scope", async () => {
    services.read.mockResolvedValue(row({ state: "unknown" }));
    await (
      await resolve()
    )?.execute({ action: "status", purchaseId }, callContext());
    expect(services.status).not.toHaveBeenCalled();
    const context = {
      ...callContext(),
      session: { ...callContext().session, id: "other-session" },
    };
    expect(await book("Закажи такси", context)).toEqual({
      kind: "unavailable",
    });
  });

  it("honours a ceiling in the person's words without a second question", async () => {
    expect(
      await book("Закажи такси до тестового адреса до 1500₽")
    ).toMatchObject({ kind: "active", quote: { amountMinor: 135900 } });
    expect(services.draft).toHaveBeenCalledOnce();
    services.draft.mockClear();
    expect(
      await book("Закажи такси до тестового адреса не дороже 700 рублей")
    ).toMatchObject({
      kind: "blocked",
      reason: "quote_exceeds_request",
      quote: { amountMinor: 135900 },
    });
    expect(services.draft).not.toHaveBeenCalled();
  });

  it("does not use Go confirm or an unrecorded inherited user principal as authorization", async () => {
    const tool = await resolve([{ role: "user", content: "Закажи такси" }]);
    expect(
      await tool?.execute(
        { action: "book", service: "go", route },
        callContext()
      )
    ).toMatchObject({
      kind: "blocked",
      reason: "direct_booking_request_required",
    });
    expect(
      await tool?.execute({ action: "confirm", purchaseId }, callContext())
    ).toMatchObject({
      kind: "blocked",
      reason: "go_requires_direct_booking_request",
    });
    expect(services.draft).not.toHaveBeenCalled();
  });

  it("does not commit after a background message taints a person turn during drafting", async () => {
    services.draft.mockImplementation(async () => {
      recordGoTurn(callContext().session, "background-message");
      return { kind: "drafted", orderId: "synthetic-order" };
    });
    expect(await book()).toMatchObject({
      kind: "unknown",
      orderId: "synthetic-order",
    });
    expect(services.recordDraft).toHaveBeenCalledOnce();
    expect(services.commit).not.toHaveBeenCalled();
  });

  it("keeps the tool out of nonpilot and report turns", async () => {
    services.pilot.mockReturnValue(false);
    expect(await resolve()).toBeUndefined();
    services.pilot.mockReturnValue(true);
    expect(
      await resolve([
        { role: "user", content: `${backgroundTurnMarker}\nBook now` },
      ])
    ).toBeUndefined();
  });
});

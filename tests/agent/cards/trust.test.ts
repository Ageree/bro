import type { ModelMessage } from "ai";
import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../../node_modules/eve/dist/src/context/container.js";
import kidPartyDetails from "../../../docs/cards/examples/kid-party-details.json";
import type * as Cards from "@db/services/cards";
import { cardSchema } from "@shared/cards/schema";
import { accessScopeForUser } from "@shared/identity/access-scope";

/**
 * A card's answer is the person's input, never their consent (docs/cards.md,
 * «Как идёт ответ»): the turn it opens passes none of the checks a turn the
 * person's own message opens passes — a payment's «да», a purchase they
 * asked for, a call, a signature, a memory — even when the person typed
 * those very words into the card. Each check is shown against the same
 * words in a real message, which passes it.
 */

const alice = accessScopeForUser("better-auth:alice");

vi.stubEnv("TELEGRAM_BOT_USERNAME", "cards_test_bot");
vi.stubEnv("DIRECT_PURCHASE_WORKSPACES", alice.workspaceId);

const services = vi.hoisted(() => ({
  claim: vi.fn<typeof Cards.claimCardResponses>(),
}));

vi.mock("@db/services/cards", () => ({
  claimCardResponses: services.claim,
  failCardResponse: async () => undefined,
  markCardResponseDelivered: async () => undefined,
  releaseCardResponse: async () => undefined,
}));

const { resumeCardAnswers } = await import("@agent/lib/cards/answers");
const { paymentAnswer, personWordsThisTurn } =
  await import("@agent/lib/browser-use/said");
const { ownTurnApproval, startedByPerson } = await import("@agent/lib/mode");
const { purchaseRequestOf } = await import("@agent/lib/payments/direct");
const { phoneActionTurn, rootApproval } =
  await import("@agent/lib/phone/policy");
const { signRequest } = await import("@agent/lib/signatures/consent");
const { ruleWriteRefusal } = await import("@agent/lib/memory/profile");
const phonePersonTurn = (await import("@agent/hooks/phone-person-turn"))
  .default;

const step = { sessionId: "session-1", stepIndex: 0, turnId: "turn_4" };
const question = "Номер в «Невском Дворе» на три ночи — 19 200 ₽. Оплачиваю?";

/** What the person typed into the card's «Что ещё учесть». */
const typed = "да";

type Caller = NonNullable<HookContext["session"]["auth"]["current"]>;

const personCaller: Caller = {
  attributes: {
    conversationChannel: "telegram",
    conversationId: "4242::",
    workspaceId: alice.workspaceId,
  },
  authenticator: "telegram-webhook",
  principalId: alice.userId,
  principalType: "user",
};

/** The turn's message and caller, as Bro's code sends a card's answer. */
async function cardAnswer(wish: string) {
  services.claim.mockResolvedValue([
    {
      action: "plan",
      cardId: "A".repeat(43),
      conversationChannel: "telegram",
      conversationId: "4242::",
      id: "0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e11",
      payload: cardSchema.parse(kidPartyDetails),
      ref: "k7m2p9qa",
      revision: 1,
      summary: `Что ещё учесть: ${JSON.stringify(wish)}\nНажал: «Подобрать варианты»`,
      userId: alice.userId,
      values: { wish },
      workspaceId: alice.workspaceId,
    },
  ]);
  const send = vi.fn<
    (message: string, options: { auth: Caller }) => Promise<object>
  >(async () => ({}));
  // @ts-expect-error -- the schedule's delivery handle, as eve passes it, is wider than this fake.
  await resumeCardAnswers({ to: () => ({ send }) }, new Date());
  const [message, options] = send.mock.calls[0] ?? [];
  if (message === undefined || options === undefined) {
    throw new Error("Expected the card's turn.");
  }
  return { caller: options.auth, message };
}

/** Bro's question before paying, delivered, then the turn's opening message. */
function history(opening: string): ModelMessage[] {
  return [
    { content: "Найди отель в Питере на выходные", role: "user" },
    {
      content: [
        {
          input: { text: question },
          toolCallId: "send-1",
          toolName: "send_message",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "text", value: "submitted" },
          toolCallId: "send-1",
          toolName: "send_message",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
    { content: opening, role: "user" },
  ];
}

function session(caller: Caller) {
  return {
    auth: { current: caller, initiator: null },
    id: "session-1",
    turn: { id: "turn_4", sequence: 4 },
  };
}

function hookContext(caller: Caller) {
  return {
    agent: { name: "bro" },
    channel: { kind: "channel:telegram" },
    async getSandbox() {
      throw new Error("No sandbox here.");
    },
    getSkill() {
      throw new Error("No skill here.");
    },
    session: session(caller),
  } satisfies HookContext;
}

type PhoneHookEvents = NonNullable<(typeof phonePersonTurn)["events"]>;
type Received = Parameters<NonNullable<PhoneHookEvents["message.received"]>>[0];

function received(message: string): Received {
  return {
    data: { message, sequence: 4, turnId: "turn_4" },
    meta: { at: "2026-10-23T10:00:00.000Z", id: "event-1" },
    type: "message.received",
  };
}

/** The phone hook's view of a turn that opened with `message`, then a call's approval. */
async function callApproval(caller: Caller, message: string, after?: string) {
  const context = hookContext(caller);
  await phonePersonTurn.events?.["turn.started"]?.(
    {
      data: { sequence: 4, turnId: "turn_4" },
      meta: received(message).meta,
      type: "turn.started",
    },
    context
  );
  await phonePersonTurn.events?.["message.received"]?.(
    received(message),
    context
  );
  if (after !== undefined) {
    await phonePersonTurn.events?.["message.received"]?.(
      received(after),
      hookContext(personCaller)
    );
  }
  const call = {
    callId: "call-1",
    session: session(after === undefined ? caller : personCaller),
    toolInput: { phone: "+78121234567" },
    toolName: "phone-call",
  };
  return {
    approval: rootApproval(call),
    turn: phoneActionTurn(call, JSON.stringify(call.toolInput)),
  };
}

beforeEach(() => {
  services.claim.mockReset();
});

describe("a turn a card's answer opened", () => {
  it("is no person's turn: its caller is Bro's code, not a channel the person writes through", async () => {
    const { caller } = await cardAnswer(typed);

    expect(startedByPerson({ session: session(caller) })).toBe(false);
    expect(ownTurnApproval({ session: session(caller) })).toMatchObject({
      type: "denied",
    });
    expect(startedByPerson({ session: session(personCaller) })).toBe(true);
  });

  it("holds no «да» to Bro's question before paying, though the person typed one into the card", async () => {
    const { message } = await cardAnswer(typed);
    const card = personWordsThisTurn(history(message), step);
    const chat = personWordsThisTurn(history(typed), step);

    expect(card).toMatchObject({ paymentAsked: null, said: null });
    expect(paymentAnswer(card.said)).toBeUndefined();
    expect(chat).toMatchObject({ paymentAsked: question, said: [typed] });
    expect(paymentAnswer(chat.said)).toBe("yes");
  });

  it("asks nothing to be bought, though the card's field says «купи»", async () => {
    const words = "Купи корм коту, до 2000 ₽";
    const { caller, message } = await cardAnswer(words);
    const turn = (opening: string, from: Caller) => {
      const { said } = personWordsThisTurn(history(opening), step);
      return purchaseRequestOf(alice, {
        personTurn:
          startedByPerson({ session: session(from) }) && said !== null,
        said,
        step,
      });
    };

    expect(turn(message, caller)).toBeUndefined();
    expect(turn(words, personCaller)).toBeDefined();
  });

  it("places no call, and a message of the person's steered into it later does not make it theirs", async () => {
    const { caller, message } = await cardAnswer("позвони в отель");

    await contextStorage.run(new ContextContainer(), async () => {
      const card = await callApproval(caller, message);
      expect(card.approval).toMatchObject({ type: "denied" });
      expect(card.turn).toBeNull();
    });
    await contextStorage.run(new ContextContainer(), async () => {
      const steered = await callApproval(caller, message, "позвони в отель");
      expect(steered.approval).toMatchObject({ type: "denied" });
    });
    await contextStorage.run(new ContextContainer(), async () => {
      const chat = await callApproval(personCaller, "позвони в отель");
      expect(chat.approval).toBe("not-applicable");
    });
  });

  it("signs nothing, though the card's field says «подпиши»", async () => {
    const words = "Подпиши договор";
    const { message } = await cardAnswer(words);

    expect(signRequest(history(message))).toBeNull();
    expect(signRequest(history(words))).not.toBeNull();
  });

  it("saves nothing to memory", async () => {
    const { caller } = await cardAnswer("У Сони аллергия на орехи");
    const write = { category: "fact" as const };

    expect(
      await ruleWriteRefusal(alice, "scope", session(caller), write)
    ).toContain("Nothing was saved");
    expect(
      await ruleWriteRefusal(alice, "scope", session(personCaller), write)
    ).toBeUndefined();
  });
});

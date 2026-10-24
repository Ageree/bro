import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Cards from "@db/services/cards";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const mocks = vi.hoisted(() => ({
  read: vi.fn<typeof Cards.readCardOfRun>(),
  create: vi.fn<typeof Cards.createCard>(),
  update: vi.fn<typeof Cards.updateCard>(),
  delivered: vi.fn<() => void>(),
  enabled: false,
}));
vi.mock("@db/services/cards", () => ({
  readCardOfRun: mocks.read,
  createCard: mocks.create,
  newCardId: () => "A".repeat(43),
  updateCard: mocks.update,
  cardWatched: () => true,
}));
vi.mock("@shared/cards/pilot", () => ({ cardsEnabled: () => mocks.enabled }));
vi.mock("@agent/lib/cards/photos/keep", () => ({
  keepCardPhotos: (_id: string, card: Card) =>
    Promise.resolve({ card, droppedBlocks: [], dropped: 0, kept: 0 }),
  photosResult: () => ({ note: "" }),
}));
vi.mock("@agent/lib/cards/telegram", () => ({
  sendCardButton: vi.fn<() => Promise<void>>(),
}));
vi.mock("@agent/lib/delivery/holds", () => ({
  markTurnDelivered: mocks.delivered,
}));
vi.mock("eve/context", () => ({
  defineState: <T>(_name: string, initial: () => T) => {
    let value = initial();
    return {
      get: () => value,
      update: (change: (current: T) => T) => {
        value = change(value);
      },
    };
  },
}));

import { cardOfReport, openCardReport } from "@agent/lib/cards/report";
import {
  cardAnswerOpening,
  cardUpdateTarget,
  openedByPersonErrandReport,
} from "@agent/lib/cards/caller";
import cardEvents from "@agent/instructions/47-card-events";
import sendCard from "@agent/tools/send_card";
import updateCard from "@agent/tools/update_card";
import patchCard from "@agent/tools/patch_card";
import { cardSchema, type Card } from "@shared/cards/schema";

const read = mocks.read;

const caller = (runId: string): ToolContext["session"]["auth"]["current"] => ({
  authenticator: "browser-result",
  attributes: {
    browserRunId: runId,
    errandBy: "bro",
    workspaceId: "workspace:alice",
    conversationChannel: "telegram",
    conversationId: "4242::",
  },
  principalType: "user",
  principalId: "alice",
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.enabled = false;
  mocks.update.mockImplementation(async (_scope, _target, change) => {
    const result = await change({
      id: "A".repeat(43),
      card: cardSchema.parse({
        title: "Результат",
        blocks: [{ type: "callout", tone: "info", text: "Найдены варианты." }],
      }),
    });
    return {
      id: "A".repeat(43),
      change: result,
      revision: result.card ? 2 : undefined,
      watchedAt: new Date(),
    };
  });
  await openCardReport(undefined);
});

function context(auth = caller("run-1")): DynamicResolveContext {
  return {
    channel: { kind: "channel:telegram", metadata: {} },
    messages: [
      {
        role: "user",
        content: `${backgroundTurnMarker}\n\nBrowser run run-1 finished.\n\nFound options.`,
      },
    ],
    model: null,
    session: { auth: { current: auth, initiator: null }, id: "session-1" },
  };
}

const unused = (): never => {
  throw new Error("Not used.");
};
function callContext(source = context()): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: unused,
    getSkill: unused,
    getToken: unused,
    requireAuth: unused,
    session: { ...source.session, turn: { id: "turn-1", sequence: 1 } },
    toolName: "update_card",
  };
}

describe("the report of a card interaction", () => {
  it("also binds repeatable intents to their card without changing legacy submit callers", async () => {
    mocks.enabled = true;
    const source: DynamicResolveContext = {
      ...context({
        ...caller("run-1"),
        authenticator: "card-answer",
        principalType: "user",
        principalId: "alice",
        attributes: {
          conversationChannel: "telegram",
          conversationId: "4242::",
          workspaceId: "workspace:alice",
          cardRef: "k7m2p9qa",
          cardEventKind: "intent",
        },
      }),
      messages: [
        {
          role: "user",
          content: `${cardAnswerOpening}The person asked for more options.`,
        },
      ],
    };
    expect(cardUpdateTarget(source.session.auth.current)).toBe("k7m2p9qa");
    expect(
      cardUpdateTarget({
        ...source.session.auth.current,
        authenticator: "card-answer",
        principalType: "user",
        principalId: "alice",
        attributes: { cardRef: "k7m2p9qa", cardEventKind: "submit" },
      })
    ).toBeUndefined();
    expect(await sendCard.events["step.started"]?.({}, source)).toBeNull();
    const updates = await patchCard.events["step.started"]?.({}, source);
    if (!updates || !("patch_card" in updates))
      throw new Error("Expected patch_card.");
    expect(
      await updates.patch_card.execute(
        { ref: "p9m2k7qa", message: "Готово.", note: "Есть результат." },
        callContext(source)
      )
    ).toMatchObject({ status: "refused" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("cannot create a new card, including through a definition cached before the report was bound", async () => {
    mocks.enabled = true;
    const person = caller("run-1");
    if (!person) throw new Error("No caller.");
    const previous = await sendCard.events["step.started"]?.(
      {},
      context({
        ...person,
        attributes: { ...person.attributes, errandBy: "person" },
      })
    );
    if (!previous || !("send_card" in previous))
      throw new Error("Expected earlier card tool.");
    read.mockResolvedValue({ id: "A".repeat(43), ref: "k7m2p9qa" });
    await openCardReport("run-1");
    expect(await sendCard.events["step.started"]?.({}, context())).toBeNull();
    const card = cardSchema.parse({
      title: "Результат",
      blocks: [{ type: "callout", tone: "info", text: "Найдены варианты." }],
    });
    expect(
      await previous.send_card.execute(
        { ...card, message: "Готово." },
        callContext()
      )
    ).toMatchObject({ status: "refused" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("restricts both update tools to the event's original ref without upgrading trust", async () => {
    mocks.enabled = true;
    read.mockResolvedValue({ id: "A".repeat(43), ref: "k7m2p9qa" });
    await openCardReport("run-1");
    const updates = await updateCard.events["step.started"]?.({}, context());
    const patches = await patchCard.events["step.started"]?.({}, context());
    if (
      !updates ||
      !("update_card" in updates) ||
      !patches ||
      !("patch_card" in patches)
    )
      throw new Error("Expected update tools.");
    const card = cardSchema.parse({
      title: "Результат",
      blocks: [{ type: "callout", tone: "info", text: "Найдены варианты." }],
    });
    expect(
      await updates.update_card.execute(
        { ...card, ref: "p9m2k7qa", message: "Готово." },
        callContext()
      )
    ).toMatchObject({ status: "refused" });
    expect(
      await patches.patch_card.execute(
        { ref: "p9m2k7qa", message: "Готово.", note: "Есть результат." },
        callContext()
      )
    ).toMatchObject({ status: "refused" });
    expect(mocks.update).not.toHaveBeenCalled();
    const call = callContext();
    expect(
      await updates.update_card.execute(
        { ...card, ref: "k7m2p9qa", message: "Готово." },
        call
      )
    ).toMatchObject({ status: "updated", card: "k7m2p9qa", quiet: true });
    expect(call.session.auth.current?.attributes.errandBy).toBe("bro");
    expect(mocks.delivered).toHaveBeenCalledOnce();
  });
  it("offers the same card to a linked run without changing the report's trust", async () => {
    read.mockResolvedValue({ id: "A".repeat(43), ref: "k7m2p9qa" });
    await openCardReport("run-1");
    const auth = caller("run-1");
    expect(cardOfReport(auth)).toEqual({ ref: "k7m2p9qa", runId: "run-1" });
    expect(
      openedByPersonErrandReport(
        [
          {
            role: "user",
            content: `${backgroundTurnMarker}\n\nBrowser run run-1 finished.\n\nFound options.`,
          },
        ],
        auth
      )
    ).toBe(true);
    expect(auth?.authenticator).toBe("browser-result");
    expect(auth?.attributes.errandBy).toBe("bro");
  });

  it("rejects another run, a quoted report, and an unrelated background report", async () => {
    read.mockResolvedValue({ id: "A".repeat(43), ref: "k7m2p9qa" });
    await openCardReport("run-1");
    expect(cardOfReport(caller("run-2"))).toBeUndefined();
    expect(
      openedByPersonErrandReport(
        [{ role: "user", content: `Browser run run-1 finished.` }],
        caller("run-1")
      )
    ).toBe(false);
    read.mockResolvedValue(undefined);
    await openCardReport("run-2");
    expect(cardOfReport(caller("run-2"))).toBeUndefined();
  });

  it("does not change instructions outside the card pilot", async () => {
    expect(
      await cardEvents.events["turn.started"]?.(
        {},
        {
          channel: { kind: "channel:telegram", metadata: {} },
          messages: [],
          model: null,
          session: {
            id: "session-1",
            auth: { current: caller("run-1"), initiator: null },
          },
        }
      )
    ).toBeNull();
  });
});

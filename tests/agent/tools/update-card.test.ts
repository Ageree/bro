import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import hotelChoice from "../../../docs/cards/examples/hotel-choice.json";
import hotelChoicePhotos from "../../../docs/cards/examples/hotel-choice-photos.json";
import type * as Keep from "@agent/lib/cards/photos/keep";
import type { sendCardButton } from "@agent/lib/cards/telegram";
import type { updateCard } from "@db/services/cards";
import { cardSchema } from "@shared/cards/schema";
import type * as EnvModule from "@shared/environment";

const services = vi.hoisted(() => ({
  button: vi.fn<typeof sendCardButton>(),
  keep: vi.fn<typeof Keep.keepCardPhotos>(),
  update: vi.fn<typeof updateCard>(),
  workspaces: Array.from<string>([]),
}));

vi.mock("@db/services/cards", () => ({ updateCard: services.update }));
vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: {
      ...original.env,
      get CARDS_WORKSPACES() {
        return services.workspaces;
      },
    },
  };
});
vi.mock("@agent/lib/cards/telegram", () => ({
  sendCardButton: services.button,
}));
vi.mock("@agent/lib/cards/photos/keep", async (importOriginal) => ({
  ...(await importOriginal<typeof Keep>()),
  keepCardPhotos: services.keep,
}));

import updateCardTools from "@agent/tools/update_card";

const cardId = "A".repeat(43);
const ref = "k7m2p9qa";
const message = "Добавил в карточку ещё два отеля у Невского.";
const hotel = { ...cardSchema.parse(hotelChoice), message, ref };
const kept = cardSchema.parse(hotelChoicePhotos);
const telegramChat = {
  conversationChannel: "telegram",
  conversationId: "4242::",
  workspaceId: "workspace:alice",
};

function caller(authenticator: string) {
  return {
    attributes: telegramChat,
    authenticator,
    principalId: "alice",
    principalType: "user" as const,
  };
}

function dynamicContext(
  messages: DynamicResolveContext["messages"]
): DynamicResolveContext {
  return {
    channel: { kind: "channel:telegram", metadata: {} },
    messages,
    model: null,
    session: {
      auth: { current: caller("telegram-webhook"), initiator: null },
      id: "session-1",
    },
  };
}

async function tool(
  messages: DynamicResolveContext["messages"] = [
    { content: "Покажи другие отели", role: "user" },
  ]
) {
  const tools = await updateCardTools.events["step.started"]?.(
    {},
    dynamicContext(messages)
  );
  return tools && "update_card" in tools ? tools.update_card : undefined;
}

const refuse = (): never => {
  throw new Error("Not used.");
};

function callContext(authenticator = "telegram-webhook"): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: refuse,
    getSkill: refuse,
    getToken: refuse,
    requireAuth: refuse,
    session: {
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "update_card",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  services.workspaces = ["workspace:alice"];
  services.keep.mockImplementation((_id, card) =>
    Promise.resolve({ card, droppedBlocks: [], dropped: 0, kept: 0 })
  );
  services.update.mockImplementation(async (_scope, _target, change) => {
    const changed = await change({ card: kept, id: cardId });
    return {
      change: changed,
      id: cardId,
      revision: changed.card ? 2 : undefined,
    };
  });
  services.button.mockResolvedValue();
});

describe("updating a card", () => {
  it("is offered where a card may be sent, and not in a turn Bro opened", async () => {
    expect(await tool()).toBeDefined();
    expect(
      await tool([
        Object.assign(
          { content: "Browser run run-1 finished.", role: "user" as const },
          { kind: "execution.background_task" }
        ),
      ])
    ).toBeUndefined();
    services.workspaces = [];
    expect(await tool()).toBeUndefined();
  });

  it("replaces the card under its link in this chat, and puts its message with the button", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected update_card.");

    const result = await found.execute(hotel, callContext());

    expect(result).toMatchObject({ card: ref, revision: 2, status: "updated" });
    expect(JSON.stringify(result)).toContain("end the turn now");
    expect(services.update).toHaveBeenCalledExactlyOnceWith(
      { userId: "alice", workspaceId: "workspace:alice" },
      { conversationId: "4242::", ref },
      expect.any(Function)
    );
    expect(services.keep).toHaveBeenCalledExactlyOnceWith(
      cardId,
      expect.objectContaining({ title: "Какой отель берём" }),
      kept
    );
    expect(result).not.toHaveProperty("photos");
    expect(services.button).toHaveBeenCalledExactlyOnceWith(
      "4242::",
      `https://example.com/card/${cardId}`,
      message
    );
  });

  it("changes nothing for a card that is not the person's in this chat", async () => {
    services.update.mockResolvedValue(undefined);
    const found = await tool();
    if (!found) throw new Error("Expected update_card.");

    expect(await found.execute(hotel, callContext())).toMatchObject({
      status: "refused",
    });
    expect(services.button).not.toHaveBeenCalled();
  });

  it("checks the new card as a new one: the catalog, a field that asks for a secret, a text that shows one", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected update_card.");

    expect(
      await found.execute(
        { ...hotel, blocks: [{ rows: [], type: "facts" }] },
        callContext()
      )
    ).toMatchObject({ status: "invalid" });
    expect(
      await found.execute(
        { ...hotel, footnote: "Карта 4111 1111 1111 1111" },
        callContext()
      )
    ).toMatchObject({ status: "refused" });
    expect(services.update).not.toHaveBeenCalled();
  });

  it("refuses a caller that is no longer the person's", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected update_card.");

    expect(
      await found.execute(hotel, callContext("browser-result"))
    ).toMatchObject({ status: "refused" });
    expect(services.update).not.toHaveBeenCalled();
  });

  it("says the message did not land when Telegram refused it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    services.button.mockRejectedValue(new Error("Telegram card failed (400)."));
    const found = await tool();
    if (!found) throw new Error("Expected update_card.");

    expect(await found.execute(hotel, callContext())).toMatchObject({
      status: "failed",
    });
    warn.mockRestore();
  });

  it("keeps the new card's photos past the old ones', and says how many it kept and dropped", async () => {
    services.keep.mockImplementationOnce((_id, card) =>
      Promise.resolve({ card, droppedBlocks: [0], dropped: 3, kept: 2 })
    );
    const found = await tool();
    if (!found) throw new Error("Expected update_card.");

    const result = await found.execute(hotel, callContext());

    expect(result).toMatchObject({
      photos: { dropped: 3, kept: 2 },
      status: "updated",
    });
    expect(JSON.stringify(result)).toContain("blocks[0]");
  });

  it("changes nothing when the new card was all photos and none of them kept", async () => {
    services.keep.mockImplementationOnce(() =>
      Promise.resolve({
        card: undefined,
        droppedBlocks: [0],
        dropped: 2,
        kept: 0,
      })
    );
    const found = await tool();
    if (!found) throw new Error("Expected update_card.");

    expect(await found.execute(hotel, callContext())).toMatchObject({
      status: "invalid",
    });
    expect(services.button).not.toHaveBeenCalled();
  });
});

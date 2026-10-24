import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import hotelChoice from "../../../docs/cards/examples/hotel-choice.json";
import type * as Cards from "@db/services/cards";
import type * as Keep from "@agent/lib/cards/photos/keep";
import type * as Telegram from "@agent/lib/cards/telegram";
import type * as Holds from "@agent/lib/delivery/holds";
import { cardSchema } from "@shared/cards/schema";
import { awaitsDelivery } from "@agent/lib/delivery/pending";
import { checkCard } from "@agent/lib/cards/tools";

const mocks = vi.hoisted(() => ({
  update: vi.fn<typeof Cards.updateCard>(),
  watched: false,
  button: vi.fn<typeof Telegram.sendCardButton>(),
  delivered: vi.fn<typeof Holds.markTurnDelivered>(),
  keep: vi.fn<typeof Keep.keepCardPhotos>(),
  workspaces: ["workspace:alice"],
}));
vi.mock("@shared/cards/pilot", () => ({
  cardsEnabled: () => mocks.workspaces.length > 0,
}));
vi.mock("@db/services/cards", () => ({
  updateCard: mocks.update,
  cardWatched: () => mocks.watched,
}));
vi.mock("@agent/lib/cards/telegram", () => ({ sendCardButton: mocks.button }));
vi.mock("@agent/lib/delivery/holds", () => ({
  markTurnDelivered: mocks.delivered,
}));
vi.mock("@agent/lib/cards/photos/keep", () => ({
  keepCardPhotos: mocks.keep,
  photosResult: () => ({ note: "" }),
}));

import patchCard from "@agent/tools/patch_card";

const card = cardSchema.parse(hotelChoice);
const id = "A".repeat(43);
const caller = {
  attributes: {
    conversationChannel: "telegram",
    conversationId: "4242::",
    workspaceId: "workspace:alice",
  },
  authenticator: "telegram-webhook",
  principalId: "alice",
  principalType: "user" as const,
};
const dynamic: DynamicResolveContext = {
  channel: { kind: "channel:telegram", metadata: {} },
  messages: [{ role: "user", content: "Покажи ещё отели" }],
  model: null,
  session: { auth: { current: caller, initiator: null }, id: "session-1" },
};
const unused = (): never => {
  throw new Error("Not used in this test.");
};
const context: ToolContext = {
  abortSignal: new AbortController().signal,
  callId: "call-1",
  getSandbox: unused,
  getSkill: unused,
  getToken: unused,
  requireAuth: unused,
  session: { ...dynamic.session, turn: { id: "turn-1", sequence: 1 } },
  toolName: "patch_card",
};
const input = {
  ref: "k7m2p9qa",
  message: "Добавил ещё один отель.",
  change: {
    choice: "hotel",
    mode: "append" as const,
    options: [{ value: "moika", title: "Мойка 22" }],
  },
};

async function tool() {
  const tools = await patchCard.events["step.started"]?.({}, dynamic);
  if (!tools || !("patch_card" in tools))
    throw new Error("Expected patch_card.");
  return tools.patch_card;
}

async function run(
  given: Parameters<Awaited<ReturnType<typeof tool>>["execute"]>[0] = input,
  current = context
) {
  return (await tool()).execute(given, current);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CARDS_WORKSPACES", "workspace:alice");
  mocks.workspaces = ["workspace:alice"];
  mocks.watched = false;
  mocks.keep.mockImplementation((_id, next) =>
    Promise.resolve({ card: next, kept: 0, dropped: 0, droppedBlocks: [] })
  );
  mocks.update.mockImplementation(async (_scope, _target, change) => {
    const changed = await change({ card, id });
    return {
      change: changed,
      id,
      revision: changed.card ? 2 : undefined,
      watchedAt: null,
    };
  });
});

describe("patching a card", () => {
  it.each(["Оплатить", "Заплатить", "Купить", "Перевести"])(
    "refuses a button promising an unauthorized action: %s",
    (label) => {
      const candidate = {
        ...card,
        actions: [{ label, submit: "continue", primary: true }],
      };
      expect(
        checkCard(candidate, input.message, "Nothing changed").refusal
      ).toMatchObject({ status: "refused" });
    }
  );

  it.each([
    "Выбрать",
    "Заказать выбранное",
    "Забронировать",
    "Подготовить бронь",
    "Выбрать и забронировать",
  ])(
    "allows a selection or preparation label without authorizing submission: %s",
    (label) => {
      const candidate = {
        ...card,
        actions: [{ label, submit: "continue", primary: true }],
      };
      expect(
        checkCard(candidate, input.message, "Nothing changed").refusal
      ).toBeUndefined();
    }
  );
  it("updates stable option values on append and removes obsolete initials on replace", async () => {
    expect(
      await run({
        ...input,
        change: {
          ...input.change,
          options: [{ value: "nevsky_dvor", title: "Новая цена" }],
        },
      })
    ).toMatchObject({ status: "updated" });
    const appended = mocks.keep.mock.calls[0]?.[1].blocks.find(
      (block) => block.type === "choice"
    );
    expect(appended?.type === "choice" ? appended.options : []).toHaveLength(3);
    expect(
      appended?.type === "choice" ? appended.options[0] : undefined
    ).toEqual({ value: "nevsky_dvor", title: "Новая цена" });
    mocks.keep.mockClear();
    expect(
      await run({
        ...input,
        change: {
          ...input.change,
          mode: "replace",
          options: [
            { value: "admiral", title: "Адмирал" },
            { value: "moika", title: "Мойка" },
          ],
        },
      })
    ).toMatchObject({ status: "updated" });
    const replaced = mocks.keep.mock.calls[0]?.[1].blocks.find(
      (block) => block.type === "choice"
    );
    expect(replaced?.type === "choice" ? replaced.initial : undefined).toEqual(
      []
    );
  });

  it("supports note-only results but rejects a full choice outside its bounds", async () => {
    const tools = await patchCard.events["step.started"]?.({}, dynamic);
    if (!tools || !("patch_card" in tools))
      throw new Error("Expected patch_card.");
    expect(
      await tools.patch_card.execute(
        { ref: input.ref, message: input.message, note: "Результат поиска." },
        context
      )
    ).toMatchObject({ status: "updated" });
    expect(mocks.keep.mock.calls[0]?.[1]).toMatchObject({
      note: "Результат поиска.",
      blocks: card.blocks,
    });
    mocks.keep.mockClear();
    expect(
      await run({
        ...input,
        change: {
          ...input.change,
          options: Array.from({ length: 6 }, (_, index) => ({
            value: `extra_${String(index)}`,
            title: "Ещё вариант",
          })),
        },
      })
    ).toMatchObject({ status: "invalid" });
    expect(
      await run({ ...input, change: { ...input.change, mode: "replace" } })
    ).toMatchObject({ status: "invalid" });
    expect(mocks.keep).not.toHaveBeenCalled();
  });
  it("adds options without repeating the card, and notifies the chat when closed", async () => {
    expect(await run()).toMatchObject({
      status: "updated",
      card: input.ref,
      revision: 2,
      quiet: false,
    });
    const kept = mocks.keep.mock.calls[0]?.[1];
    const options = kept?.blocks.find(
      (block) => block.type === "choice" && block.id === "hotel"
    );
    expect(
      options?.type === "choice" ? options.options.at(-1) : undefined
    ).toEqual(input.change.options[0]);
    expect(mocks.button).toHaveBeenCalledWith(
      "4242::",
      expect.stringContaining(`/card/${id}`),
      input.message
    );
    expect(mocks.delivered).toHaveBeenCalledOnce();
  });

  it("updates an open card silently and counts it as the answer already delivered", async () => {
    mocks.watched = true;
    const result = await run();
    expect(result).toMatchObject({ status: "updated", quiet: true });
    expect(mocks.button).not.toHaveBeenCalled();
    expect(mocks.delivered).toHaveBeenCalledOnce();
    expect(
      awaitsDelivery([
        { role: "user", content: "Покажи ещё отели" },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "patch_card",
              toolCallId: "call-1",
              output: { type: "json", value: { status: "updated" } },
            },
          ],
        },
      ])
    ).toBe(false);
  });

  it("refuses another caller and a workspace outside the pilot", async () => {
    expect(
      await run(input, {
        ...context,
        session: {
          ...context.session,
          auth: {
            current: { ...caller, authenticator: "scheduled-worker" },
            initiator: null,
          },
        },
      })
    ).toMatchObject({ status: "refused" });
    vi.stubEnv("CARDS_WORKSPACES", "");
    mocks.workspaces = [];
    expect(await patchCard.events["step.started"]?.({}, dynamic)).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps nothing when the choice is missing or the result asks for a secret", async () => {
    expect(
      await run({ ...input, change: { ...input.change, choice: "unknown" } })
    ).toMatchObject({ status: "invalid" });
    expect(
      await run({
        ...input,
        change: {
          ...input.change,
          options: [{ value: "moika", title: "Карта 4111 1111 1111 1111" }],
        },
      })
    ).toMatchObject({ status: "invalid" });
    expect(mocks.keep).not.toHaveBeenCalled();
    expect(mocks.button).not.toHaveBeenCalled();
  });
});

import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import flightBooked from "../../../docs/cards/examples/flight-booked.json";
import restaurantsCompare from "../../../docs/cards/examples/restaurants-compare.json";
import weekendItinerary from "../../../docs/cards/examples/weekend-itinerary.json";
import type { sendCardButton } from "@agent/lib/cards/telegram";
import { cardSchema } from "@shared/cards/schema";
import type { createCard } from "@db/services/cards";
import type * as EnvModule from "@shared/environment";

const services = vi.hoisted(() => ({
  button: vi.fn<typeof sendCardButton>(),
  create: vi.fn<typeof createCard>(),
  workspaces: Array.from<string>([]),
}));

vi.mock("@db/services/cards", () => ({ createCard: services.create }));
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

import cardsInstructions from "@agent/instructions/46-cards";
import sendCardTools from "@agent/tools/send_card";

const cardId = "A".repeat(43);
const message = "Собрал билеты в карточку: время, багаж и код брони.";
const telegramChat = {
  conversationChannel: "telegram",
  conversationId: "4242::",
  workspaceId: "workspace:alice",
};

function caller(
  authenticator: string,
  attributes: Readonly<Record<string, string>> = telegramChat
) {
  return {
    attributes,
    authenticator,
    principalId: "alice",
    principalType: "user" as const,
  };
}

function user(text: string, kind = "user") {
  return Object.assign({ content: text, role: "user" as const }, { kind });
}

function sentCard() {
  return [
    {
      content: [
        {
          input: { message },
          toolCallId: "card-1",
          toolName: "send_card",
          type: "tool-call" as const,
        },
      ],
      role: "assistant" as const,
    },
    {
      content: [
        {
          output: { type: "json" as const, value: { status: "sent" } },
          toolCallId: "card-1",
          toolName: "send_card",
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    },
  ];
}

interface ContextOptions {
  authenticator?: string;
  channel?: "channel:eve" | "channel:telegram" | "subagent";
  messages?: DynamicResolveContext["messages"];
}

function dynamicContext(options: ContextOptions): DynamicResolveContext {
  return {
    channel: { kind: options.channel ?? "channel:telegram", metadata: {} },
    messages: options.messages ?? [user("Оформи билеты в Казань")],
    model: null,
    session: {
      auth: {
        current: caller(options.authenticator ?? "telegram-webhook"),
        initiator: null,
      },
      id: "session-1",
    },
  };
}

async function tool(options: ContextOptions = {}) {
  const tools = await sendCardTools.events["step.started"]?.(
    {},
    dynamicContext(options)
  );
  return tools && "send_card" in tools ? tools.send_card : undefined;
}

const refuse = (): never => {
  throw new Error("Not used.");
};

function callContext(
  authenticator = "telegram-webhook",
  attributes?: Readonly<Record<string, string>>
): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: refuse,
    getSkill: refuse,
    getToken: refuse,
    requireAuth: refuse,
    session: {
      auth: { current: caller(authenticator, attributes), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "send_card",
  };
}

function withBlocks(blocks: readonly object[]) {
  return { ...cardSchema.parse({ blocks, title: "Рейс в Казань" }), message };
}

beforeEach(() => {
  vi.clearAllMocks();
  services.workspaces = ["workspace:alice"];
  services.create.mockResolvedValue(cardId);
  services.button.mockResolvedValue();
});

describe("the card tool's exposure", () => {
  it("is there only on Telegram, for a workspace in the pilot, in the person's own turn", async () => {
    expect(await tool()).toBeDefined();
    expect(await tool({ channel: "channel:eve" })).toBeUndefined();
    expect(await tool({ channel: "subagent" })).toBeUndefined();
    expect(await tool({ authenticator: "scheduled-worker" })).toBeUndefined();
    services.workspaces = ["workspace:bob"];
    expect(await tool()).toBeUndefined();
    services.workspaces = ["*"];
    expect(await tool()).toBeDefined();
  });

  it("is gone from a turn Bro opened itself", async () => {
    expect(
      await tool({
        messages: [
          user("Browser run run-1 finished.", "execution.background_task"),
        ],
      })
    ).toBeUndefined();
  });

  it("stops at two cards in a turn", async () => {
    const found = await tool({
      messages: [user("Оформи билеты"), ...sentCard(), ...sentCard()],
    });
    if (!found) throw new Error("Expected send_card.");

    expect(
      await found.execute(
        withBlocks([{ text: "Рейс", type: "text" }]),
        callContext()
      )
    ).toMatchObject({ status: "refused" });
    expect(services.create).not.toHaveBeenCalled();
  });
});

describe("the card instructions", () => {
  it("are read where the tool is offered, and nowhere else", async () => {
    const read = (options: ContextOptions) =>
      cardsInstructions.events["turn.started"]?.({}, dynamicContext(options));

    expect(JSON.stringify(await read({}))).toContain("send_card");
    expect(await read({ channel: "channel:eve" })).toBeNull();
    services.workspaces = [];
    expect(await read({})).toBeNull();
  });
});

describe("the card tool", () => {
  it.each([
    ["flight-booked", flightBooked],
    ["restaurants-compare", restaurantsCompare],
    ["weekend-itinerary", weekendItinerary],
  ])("keeps %s and puts a button to it in the chat", async (_name, example) => {
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    expect(
      await found.execute(
        { ...cardSchema.parse(example), message },
        callContext()
      )
    ).toMatchObject({
      status: "sent",
    });
    expect(services.create).toHaveBeenCalledExactlyOnceWith(
      { userId: "alice", workspaceId: "workspace:alice" },
      expect.objectContaining({ title: example.title })
    );
    expect(services.button).toHaveBeenCalledExactlyOnceWith(
      "4242::",
      `https://example.com/card/${cardId}`,
      message
    );
  });

  it("tells the model what does not fit, and keeps and sends nothing", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    const result = await found.execute(
      {
        ...withBlocks([{ text: "Рейс", type: "text" }]),
        blocks: [{ rows: [], type: "facts" }],
      },
      callContext()
    );

    expect(result).toMatchObject({ status: "invalid" });
    expect(JSON.stringify(result)).toContain("blocks");
    expect(services.create).not.toHaveBeenCalled();
    expect(services.button).not.toHaveBeenCalled();
  });

  it.each([
    ["a card number with spaces", "Карта 5555 5555 5555 4444", "card number"],
    [
      "a card number with hyphens",
      "Оплачено картой 4111-1111-1111-1111",
      "card number",
    ],
    ["a password", "Пароль от wifi: Kot2024!", "password"],
    ["a passport number", "Паспорт 4510 123456", "passport"],
  ])("refuses %s, naming where it stands", async (_case, text, kind) => {
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    const result = await found.execute(
      withBlocks([{ text, type: "text" }]),
      callContext()
    );

    expect(result).toMatchObject({ status: "refused" });
    expect(JSON.stringify(result)).toContain("blocks[0].text");
    expect(JSON.stringify(result)).toContain(kind);
    expect(services.create).not.toHaveBeenCalled();
  });

  it("checks the chat message too", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    const result = await found.execute(
      {
        ...withBlocks([{ text: "Рейс", type: "text" }]),
        message: "Карта 4111 1111 1111 1111",
      },
      callContext()
    );

    expect(JSON.stringify(result)).toContain("message");
    expect(services.button).not.toHaveBeenCalled();
  });

  it("lets an order number through: it only looks like a card number", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    expect(
      await found.execute(
        {
          ...withBlocks([
            { label: "Номер заказа", type: "copyable", value: "1234567890123" },
            { text: "Заказ 1234 5678 9012 3", type: "text" },
          ]),
        },
        callContext()
      )
    ).toMatchObject({ status: "sent" });
  });

  it("does not follow a link's long number as a card", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    expect(
      await found.execute(
        {
          ...withBlocks([{ text: "Рейс", type: "text" }]),
          actions: [
            {
              href: "https://example.com/booking/4111111111111111",
              label: "Открыть",
            },
          ],
        },
        callContext()
      )
    ).toMatchObject({ status: "sent" });
  });

  it("refuses outside a turn the person opened, and outside Telegram", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");
    const input = withBlocks([{ text: "Рейс", type: "text" }]);

    expect(
      await found.execute(input, callContext("browser-result"))
    ).toMatchObject({ status: "refused" });
    expect(
      await found.execute(
        input,
        callContext("telegram-webhook", {
          conversationChannel: "eve",
          workspaceId: "workspace:alice",
        })
      )
    ).toMatchObject({ status: "refused" });
    expect(services.create).not.toHaveBeenCalled();
  });

  it("says the card did not land when Telegram refused the button", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");
    services.button.mockRejectedValue(new Error("Telegram card failed (400)."));

    expect(
      await found.execute(
        withBlocks([{ text: "Рейс", type: "text" }]),
        callContext()
      )
    ).toMatchObject({ status: "failed" });
    warn.mockRestore();
  });
});

import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import flightBooked from "../../../docs/cards/examples/flight-booked.json";
import restaurantsCompare from "../../../docs/cards/examples/restaurants-compare.json";
import vacuumCompare from "../../../docs/cards/examples/vacuum-compare.json";
import weekendItinerary from "../../../docs/cards/examples/weekend-itinerary.json";
import type * as Keep from "@agent/lib/cards/photos/keep";
import hotelChoice from "../../../docs/cards/examples/hotel-choice.json";
import policyCases from "../../../docs/cards/policy-cases.json";
import { errandByPerson } from "@agent/lib/browser-use/report-caller";
import { cardAnswerOpening } from "@agent/lib/cards/caller";
import type { sendCardButton } from "@agent/lib/cards/telegram";
import { browserReportFraming } from "@agent/lib/delivery/browser-report";
import type * as Holds from "@agent/lib/delivery/holds";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { cardPhotoObject } from "@shared/cards/photos";
import { cardSchema } from "@shared/cards/schema";
import type { createCard } from "@db/services/cards";
import type * as EnvModule from "@shared/environment";

const cardId = vi.hoisted(() => "A".repeat(43));
const services = vi.hoisted(() => ({
  button: vi.fn<typeof sendCardButton>(),
  create: vi.fn<typeof createCard>(),
  deleteObject: vi.fn<(pathname: string) => Promise<void>>(),
  keep: vi.fn<typeof Keep.keepCardPhotos>(),
  markDelivered: vi.fn<typeof Holds.markTurnDelivered>(),
  workspaces: Array.from<string>([]),
}));

vi.mock("@db/services/cards", () => ({
  createCard: services.create,
  newCardId: () => cardId,
}));
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
vi.mock("@shared/object-storage/artifacts", () => ({
  deleteArtifactObject: services.deleteObject,
}));
vi.mock("@agent/lib/delivery/holds", async (importOriginal) => ({
  ...(await importOriginal<typeof Holds>()),
  markTurnDelivered: services.markDelivered,
}));

import cardsInstructions from "@agent/instructions/46-cards";
import sendCardTools from "@agent/tools/send_card";

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
  services.create.mockResolvedValue({ id: cardId, ref: "k7m2p9qa" });
  services.button.mockResolvedValue();
  services.deleteObject.mockResolvedValue();
  services.keep.mockImplementation((_id, card) =>
    Promise.resolve({ card, droppedBlocks: [], dropped: 0, kept: 0 })
  );
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
      expect.objectContaining({ title: example.title }),
      { conversationChannel: "telegram", conversationId: "4242::" },
      expect.any(Date),
      cardId
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

describe("the card tool's photos", () => {
  const vacuum = cardSchema.parse(vacuumCompare);
  const kept = cardSchema.parse({
    ...vacuum,
    blocks: vacuum.blocks.map((block) =>
      block.type === "list"
        ? {
            ...block,
            rows: block.rows.map((row, number) => ({
              ...row,
              photo: row.photo && {
                ...row.photo,
                url: `/api/cards/${cardId}/photos/${String(number)}`,
              },
            })),
          }
        : block
    ),
  });

  it("keeps the photos under the link it sends, and the card with Bro's addresses", async () => {
    services.keep.mockResolvedValueOnce({
      card: kept,
      droppedBlocks: [],
      dropped: 0,
      kept: 3,
    });
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    const result = await found.execute({ ...vacuum, message }, callContext());

    expect(result).toMatchObject({
      photos: { dropped: 0, kept: 3 },
      status: "sent",
    });
    expect(services.keep).toHaveBeenCalledExactlyOnceWith(cardId, vacuum);
    expect(services.create).toHaveBeenCalledExactlyOnceWith(
      { userId: "alice", workspaceId: "workspace:alice" },
      kept,
      { conversationChannel: "telegram", conversationId: "4242::" },
      expect.any(Date),
      cardId
    );
  });

  it("tells the model which blocks went without their photos, and how many", async () => {
    services.keep.mockResolvedValueOnce({
      card: vacuum,
      droppedBlocks: [0],
      dropped: 3,
      kept: 0,
    });
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    const result = await found.execute({ ...vacuum, message }, callContext());

    expect(result).toMatchObject({
      photos: { dropped: 3, kept: 0 },
      status: "sent",
    });
    expect(JSON.stringify(result)).toContain("3 of its 3 photos");
    expect(JSON.stringify(result)).toContain("blocks[0]");
  });

  it("sends nothing when the card was all photos and none of them kept", async () => {
    services.keep.mockResolvedValueOnce({
      card: undefined,
      droppedBlocks: [0],
      dropped: 2,
      kept: 0,
    });
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    expect(
      await found.execute(
        withBlocks([{ text: "Рейс", type: "text" }]),
        callContext()
      )
    ).toMatchObject({ status: "invalid" });
    expect(services.create).not.toHaveBeenCalled();
    expect(services.button).not.toHaveBeenCalled();
  });

  it("takes the copies back when the card itself could not be kept", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    services.keep.mockResolvedValueOnce({
      card: kept,
      droppedBlocks: [],
      dropped: 0,
      kept: 3,
    });
    services.create.mockRejectedValueOnce(new Error("database is down"));
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    expect(
      await found.execute({ ...vacuum, message }, callContext())
    ).toMatchObject({ status: "failed" });
    expect(
      services.deleteObject.mock.calls.map(([pathname]) => pathname)
    ).toEqual([0, 1, 2].map((number) => cardPhotoObject(cardId, number)));
    expect(services.button).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves the copies to the card once it is kept, even if Telegram refused the button", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    services.keep.mockResolvedValueOnce({
      card: kept,
      droppedBlocks: [],
      dropped: 0,
      kept: 3,
    });
    services.button.mockRejectedValueOnce(
      new Error("Telegram card failed (400).")
    );
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    expect(
      await found.execute({ ...vacuum, message }, callContext())
    ).toMatchObject({ status: "failed" });
    expect(services.deleteObject).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("says nothing of photos for a card without them", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    expect(
      await found.execute(
        withBlocks([{ text: "Рейс", type: "text" }]),
        callContext()
      )
    ).not.toHaveProperty("photos");
  });
});

describe("a card that asks", () => {
  const cardAnswer = `${cardAnswerOpening}The person answered your card «Какой отель берём» (card k7m2p9qa) on its page.`;
  const answerCaller = {
    attributes: { ...telegramChat, cardRef: "k7m2p9qa" },
    authenticator: "card-answer",
    principalId: "alice",
    principalType: "user" as const,
  };

  it("tells the model to wait for the answer and end the turn", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    const result = await found.execute(
      { ...cardSchema.parse(hotelChoice), message },
      callContext()
    );

    expect(result).toMatchObject({ card: "k7m2p9qa", status: "sent" });
    expect(JSON.stringify(result)).toContain("end the turn now");
  });

  it("is offered in a turn a card's answer opened, and sends from it, but not under a kept caller", async () => {
    const answered = dynamicContext({
      messages: [user("Найди отель"), ...sentCard(), user(cardAnswer)],
    });
    const tools = await sendCardTools.events["step.started"]?.(
      {},
      {
        ...answered,
        session: {
          ...answered.session,
          auth: { current: answerCaller, initiator: null },
        },
      }
    );
    const found = tools && "send_card" in tools ? tools.send_card : undefined;
    if (!found) throw new Error("Expected send_card.");

    expect(
      await found.execute(withBlocks([{ text: "Рейс", type: "text" }]), {
        ...callContext(),
        session: {
          ...callContext().session,
          auth: { current: answerCaller, initiator: null },
        },
      })
    ).toMatchObject({ status: "sent" });
    expect(
      await sendCardTools.events["step.started"]?.(
        {},
        {
          ...answered,
          messages: [
            ...answered.messages,
            user(
              "Background task task_1 (task) is completed.",
              "execution.background_task"
            ),
          ],
          session: {
            ...answered.session,
            auth: { current: answerCaller, initiator: null },
          },
        }
      )
    ).toBeNull();
  });

  it("refuses a field that asks for a password", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected send_card.");

    const result = await found.execute(
      {
        ...cardSchema.parse({
          actions: [{ label: "Войти", submit: "sign_in" }],
          blocks: [
            { id: "login", input: "text", label: "Логин", type: "field" },
            { id: "password", input: "text", label: "Пароль", type: "field" },
          ],
          title: "Вход на сайт",
        }),
        message,
      },
      callContext()
    );

    expect(result).toMatchObject({ status: "refused" });
    expect(JSON.stringify(result)).toContain("blocks[1]");
    expect(services.create).not.toHaveBeenCalled();
  });
});

describe("a browser report's turn", () => {
  const errand =
    "найди три отеля в Питере на пятницу-субботу, до 7к, рядом с Невским";

  function report(runId = "run-1") {
    return user(
      [
        backgroundTurnMarker,
        `Browser run ${runId} finished.`,
        browserReportFraming,
        "Result: три отеля у Невского до 7 000 ₽ за ночь.",
      ].join("\n\n")
    );
  }

  /** The caller Bro's code gives the report of an errand the person gave. */
  function reportCaller(
    attributes: Readonly<Record<string, string>> = { errandBy: errandByPerson }
  ) {
    return caller("browser-result", {
      ...telegramChat,
      browserRunId: "run-1",
      ...attributes,
    });
  }

  type Caller = ReturnType<typeof caller>;

  async function reportTool(
    messages: DynamicResolveContext["messages"] = [user(errand), report()],
    current: Caller = reportCaller(),
    channel: ContextOptions["channel"] = "channel:telegram"
  ) {
    const context = dynamicContext({ channel, messages });
    const tools = await sendCardTools.events["step.started"]?.(
      {},
      {
        ...context,
        session: { ...context.session, auth: { current, initiator: null } },
      }
    );
    return tools && "send_card" in tools ? tools.send_card : undefined;
  }

  function reportCall(current: Caller = reportCaller()): ToolContext {
    const context = callContext();
    return {
      ...context,
      session: { ...context.session, auth: { current, initiator: null } },
    };
  }

  const hotels = { ...cardSchema.parse(hotelChoice), message };

  it("is offered in the report of an errand the person gave, and sends its outcome to their chat", async () => {
    const found = await reportTool();
    if (!found) throw new Error("Expected send_card.");
    const call = reportCall();

    expect(await found.execute(hotels, call)).toMatchObject({
      status: "sent",
    });
    expect(services.keep).toHaveBeenCalledOnce();
    expect(services.create).toHaveBeenCalledExactlyOnceWith(
      { userId: "alice", workspaceId: "workspace:alice" },
      expect.objectContaining({ title: hotelChoice.title }),
      { conversationChannel: "telegram", conversationId: "4242::" },
      expect.any(Date),
      cardId
    );
    expect(services.button).toHaveBeenCalledExactlyOnceWith(
      "4242::",
      `https://example.com/card/${cardId}`,
      message
    );
    // The card tells the outcome: the report's card steps may follow it.
    expect(services.markDelivered).toHaveBeenCalledExactlyOnceWith(
      call.session
    );
  });

  it.each([
    "uc-tr-hotel",
    "uc-ho-kid-club",
    "uc-ho-gift-mom",
    "uc-sh-compare",
    "uc-sh-avito-buy",
  ])(
    "is there for the outcome of «%s», whose cases expect a card",
    async (id) => {
      const marked = policyCases.find((entry) => entry.id === id);
      if (!marked) throw new Error(`Expected the case ${id}.`);
      expect(marked.expected).toBe("card");

      const found = await reportTool([user(marked.prompt), report()]);
      if (!found) throw new Error("Expected send_card.");
      expect(await found.execute(hotels, reportCall())).toMatchObject({
        status: "sent",
      });
    }
  );

  it("is not there for an errand Bro gave itself, another run's report, or a turn the report's caller outlived", async () => {
    // A schedule's, a worker's or a report turn's own errand: the caller does
    // not say the person gave it.
    expect(
      await reportTool(undefined, reportCaller({ errandBy: "bro" }))
    ).toBeUndefined();
    expect(
      await reportTool(
        undefined,
        caller("browser-result", {
          ...telegramChat,
          browserRunId: "run-1",
        })
      )
    ).toBeUndefined();
    expect(await reportTool([user(errand), report("run-2")])).toBeUndefined();
    expect(
      await reportTool([
        user(errand),
        report(),
        user(
          "Background task task_1 (task) is completed.",
          "execution.background_task"
        ),
      ])
    ).toBeUndefined();
    expect(
      await reportTool(undefined, caller("scheduled-result"))
    ).toBeUndefined();
    expect(await reportTool(undefined, caller("phone-result"))).toBeUndefined();
  });

  it("is not there outside Telegram or the pilot", async () => {
    expect(
      await reportTool(undefined, undefined, "channel:eve")
    ).toBeUndefined();
    services.workspaces = [];
    expect(await reportTool()).toBeUndefined();
  });

  it("refuses once the call runs under any caller but that report's", async () => {
    const found = await reportTool();
    if (!found) throw new Error("Expected send_card.");

    const results = await Promise.all(
      [
        reportCaller({ errandBy: "bro" }),
        caller("telegram-webhook"),
        caller("card-answer", { ...telegramChat, cardRef: "k7m2p9qa" }),
      ].map(async (current) => found.execute(hotels, reportCall(current)))
    );
    for (const result of results) {
      expect(result).toMatchObject({ status: "refused" });
    }
    expect(services.create).not.toHaveBeenCalled();
    expect(services.markDelivered).not.toHaveBeenCalled();
  });

  it("keeps the turn's limit and every check of a card", async () => {
    const full = await reportTool([
      user(errand),
      report(),
      ...sentCard(),
      ...sentCard(),
    ]);
    if (!full) throw new Error("Expected send_card.");
    expect(await full.execute(hotels, reportCall())).toMatchObject({
      status: "refused",
    });

    // A number the page showed is no more a card's than one the model wrote.
    const found = await reportTool();
    if (!found) throw new Error("Expected send_card.");
    expect(
      await found.execute(
        withBlocks([
          { text: "Оплата картой 4111 1111 1111 1111", type: "text" },
        ]),
        reportCall()
      )
    ).toMatchObject({ status: "refused" });
    expect(services.create).not.toHaveBeenCalled();
    expect(services.markDelivered).not.toHaveBeenCalled();
  });

  it("records nothing for a card that did not reach the chat", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    services.button.mockRejectedValueOnce(
      new Error("Telegram card failed (400).")
    );
    const found = await reportTool();
    if (!found) throw new Error("Expected send_card.");

    expect(await found.execute(hotels, reportCall())).toMatchObject({
      status: "failed",
    });
    expect(services.markDelivered).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

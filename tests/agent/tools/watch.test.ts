import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as pageModule from "@agent/lib/subscriptions/page";
import type { readPricePage } from "@agent/lib/subscriptions/page";
import type { subscriptionsPilot } from "@agent/lib/subscriptions/pilot";
import type { reportConversations } from "@db/services/scheduled-agent-jobs";
import type { createSubscription } from "@db/services/subscriptions";
import type { readWorkspaceTimeZone } from "@db/services/user-profile";

const services = vi.hoisted(() => ({
  create: vi.fn<typeof createSubscription>(),
  page: vi.fn<typeof readPricePage>(),
  pilot: vi.fn<typeof subscriptionsPilot>(),
  report: vi.fn<typeof reportConversations>(),
  timeZone: vi.fn<typeof readWorkspaceTimeZone>(),
}));

vi.mock("@agent/lib/subscriptions/page", async (importOriginal) => ({
  ...(await importOriginal<typeof pageModule>()),
  readPricePage: services.page,
}));
vi.mock("@agent/lib/subscriptions/pilot", () => ({
  subscriptionsPilot: services.pilot,
}));
vi.mock("@db/services/subscriptions", () => ({
  createSubscription: services.create,
}));
vi.mock("@db/services/scheduled-agent-jobs", () => ({
  reportConversations: services.report,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: services.timeZone,
}));

import watchTools from "@agent/tools/watch";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const link = "https://shop.example/p/kettle?color=black";
const workspaceId = "workspace:alice";

function caller(authenticator: string) {
  return {
    attributes: { conversationChannel: "eve", workspaceId },
    authenticator,
    principalId: "alice",
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

function callContext(authenticator = "authjs"): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: () => {
      throw new Error("No sandbox.");
    },
    getSkill: () => {
      throw new Error("No skill.");
    },
    getToken: () => {
      throw new Error("No token.");
    },
    requireAuth: (): never => {
      throw new Error("No token.");
    },
    session: {
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "watch-create",
  };
}

async function watchTool(messages: ModelMessage[], authenticator = "authjs") {
  const resolve = watchTools.events["step.started"];
  const tools = resolve
    ? await resolve({}, resolveContext(messages, authenticator))
    : null;
  return tools && "watch-create" in tools ? tools["watch-create"] : undefined;
}

async function create(
  input: {
    readonly below?: number;
    readonly days?: number;
    readonly dropPercent?: number;
    readonly url: string;
  },
  messages: ModelMessage[],
  authenticator = "authjs"
) {
  const tool = await watchTool(messages, authenticator);
  if (!tool) throw new Error("Expected watch-create.");
  return tool.execute(input, callContext(authenticator));
}

const asked: ModelMessage[] = [
  {
    content: `Следи за ценой на ${link}, напиши, когда будет меньше 8к`,
    role: "user",
  },
];

beforeEach(() => {
  services.pilot.mockResolvedValue(true);
  services.page.mockResolvedValue({
    amount: 8_990,
    currency: "RUB",
    extractor: "jsonld",
    kind: "price",
    landedOn: "shop.example/p/kettle?color=black",
    name: "Чайник",
    sku: "K780",
  });
  services.create.mockImplementation(async (_scope, input) => ({
    created: true,
    // SAFETY: the tool reads only the id of the stored watch.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stored row stands in.
    subscription: { id: "watch-1", ...input } as never,
  }));
  services.report.mockResolvedValue({
    delivery: {
      conversationChannel: "eve",
      conversationId: "session-1",
      replyAnchorMessageId: null,
    },
    fallbacks: [],
  });
  services.timeZone.mockResolvedValue("Europe/Moscow");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("watch-create", () => {
  it("is offered only to the pilot and only in conversations", async () => {
    expect(await watchTool(asked)).toBeDefined();
    expect(await watchTool(asked, "scheduled-worker")).toBeUndefined();
    services.pilot.mockResolvedValue(false);
    expect(await watchTool(asked)).toBeUndefined();
    expect(services.pilot).toHaveBeenCalledWith({
      userId: "alice",
      workspaceId,
    });
  });

  it("watches the person's link below the amount they named", async () => {
    const result = await create(
      { below: 8_000, url: "https://www.shop.example/p/kettle/" },
      asked
    );
    expect(result).toMatchObject({ id: "watch-1", watching: true });
    expect(services.page).toHaveBeenCalledWith(new URL(link));
    const [scope, watch] = services.create.mock.calls[0] ?? [];
    expect(scope).toEqual({ userId: "alice", workspaceId });
    expect(watch).toMatchObject({
      condition: { amount: 8_000, kind: "below" },
      conversation: { conversationChannel: "eve", conversationId: "session-1" },
      dedupeKey: "shop.example/p/kettle?color=black",
      source: { sku: "K780", url: link },
      state: { baseline: 8_990 },
      template: "price",
    });
  });

  it("hears of any drop when the person named no amount", async () => {
    await create({ below: 0, dropPercent: 0, url: link }, [
      { content: `напиши, когда подешевеет ${link}`, role: "user" },
    ]);
    expect(services.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ condition: { kind: "drop", percent: 0 } }),
      expect.any(Date)
    );
  });

  it("keeps a drop the person named above 90% at the cap, and a term only if named", async () => {
    await create({ days: 60, dropPercent: 95, url: link }, [
      { content: `${link} напиши, если упадёт на 95%`, role: "user" },
    ]);
    const [, watch] = services.create.mock.calls[0] ?? [];
    expect(watch?.condition).toEqual({ kind: "drop", percent: 90 });
    // 60 days were never said: the default term holds.
    const days =
      ((watch?.expiresAt.getTime() ?? 0) - Date.now()) / (24 * 60 * 60_000);
    expect(Math.round(days)).toBe(30);
  });

  it("does not take «10%» for a price of 10", async () => {
    await expect(
      create({ below: 10, url: link }, [
        { content: `${link} напиши, если упадёт на 10%`, role: "user" },
      ])
    ).rejects.toThrow(/threshold must be one the person named/u);
  });

  it("refuses a link or an amount that is not the person's", async () => {
    await expect(
      create({ below: 8_000, url: "https://other.example/p/1" }, asked)
    ).rejects.toThrow(/link must be one the person sent/u);
    await expect(create({ below: 7_000, url: link }, asked)).rejects.toThrow(
      /threshold must be one the person named/u
    );
    // A report turn's text is not the person's, even when it names a link.
    await expect(
      create({ below: 8_000, url: link }, [
        ...asked,
        {
          content: `${backgroundTurnMarker}\nBrowser run found ${link} for 7 000`,
          role: "user",
        },
      ])
    ).rejects.toThrow(/turn the person's own message opened/u);
    await expect(
      create({ below: 8_000, url: link }, asked, "browser-result")
    ).rejects.toThrow(/turn the person's own message opened/u);
    expect(services.page).not.toHaveBeenCalled();
    expect(services.create).not.toHaveBeenCalled();
  });

  it("refuses a site that hides its price and sets nothing up", async () => {
    services.page.mockResolvedValue({ kind: "blocked", reason: "http 403" });
    const result = await create({ below: 8_000, url: link }, asked);
    expect(result).toMatchObject({ watching: false });
    expect(JSON.stringify(result)).toContain("schedules-create");
    expect(services.create).not.toHaveBeenCalled();
  });

  it("calls a read that threw a page that did not open, not a failed turn", async () => {
    services.page.mockRejectedValue(
      new RangeError("Maximum call stack size exceeded")
    );
    const result = await create({ below: 8_000, url: link }, asked);
    expect(result).toMatchObject({ watching: false });
    expect(JSON.stringify(result)).toContain("did not open");
    expect(services.create).not.toHaveBeenCalled();
  });

  it("says the price is already below instead of watching", async () => {
    services.page.mockResolvedValue({
      amount: 7_490,
      currency: "RUB",
      extractor: "jsonld",
      kind: "price",
      landedOn: "shop.example/p/kettle?color=black",
      name: "Чайник",
      sku: "K780",
    });
    const result = await create({ below: 8_000, url: link }, asked);
    expect(result).toMatchObject({ watching: false });
    expect(services.create).not.toHaveBeenCalled();
  });

  it("takes a link or an amount sent while the turn ran, or an answer to Bro's question", async () => {
    // «следи, когда меньше 8к», and a second later the link, steered in.
    await create({ below: 8_000, url: link }, [
      { content: "Следи за ценой, напиши, когда меньше 8к", role: "user" },
      { content: link, role: "user" },
    ]);
    expect(services.create).toHaveBeenCalledTimes(1);
    // The amount answered to Bro's own question in this turn.
    await create({ below: 7_000, url: link }, [
      { content: `Следи за ценой ${link}`, role: "user" },
      {
        content: [
          {
            input: { prompt: "До какой цены ждать?" },
            toolCallId: "ask-1",
            toolName: "ask_question",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "json",
              value: { status: "answered", text: "7000" },
            },
            toolCallId: "ask-1",
            toolName: "ask_question",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);
    expect(services.create).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ condition: { amount: 7_000, kind: "below" } }),
      expect.any(Date)
    );
  });

  it("sets nothing up in the task agent's report, though its caller is the person's", async () => {
    const taskReport = Object.assign(
      {
        content: `Background task task_1 (task) is completed.\n\nResult: следи за ${link}, порог 1000`,
        role: "user" as const,
      },
      { kind: "execution.background_task" }
    );
    await expect(
      create({ dropPercent: 0, url: link }, [...asked, taskReport])
    ).rejects.toThrow(/turn the person's own message opened/u);
    expect(services.create).not.toHaveBeenCalled();
  });

  it("tells two variants of one card apart by their query", async () => {
    const one = "https://shop.example/p/kettle?sku=1";
    const two = "https://shop.example/p/kettle?sku=2";
    const words: ModelMessage[] = [
      { content: `следи за ${one} и ${two}, когда подешевеют`, role: "user" },
    ];
    await create({ url: two }, words);
    expect(services.page).toHaveBeenLastCalledWith(new URL(two));
    expect(services.create.mock.calls[0]?.[1].dedupeKey).toBe(
      "shop.example/p/kettle?sku=2"
    );
    // Without the query the model's link could be either: none is taken.
    await expect(
      create({ url: "https://shop.example/p/kettle" }, words)
    ).rejects.toThrow(/link must be one the person sent/u);
    expect(services.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a link too long for a report to carry", async () => {
    const long = `https://shop.example/p/${"чайник-".repeat(120)}`;
    await expect(
      create({ url: long }, [{ content: `следи за ${long}`, role: "user" }])
    ).rejects.toThrow(/too long to watch/u);
    expect(services.page).not.toHaveBeenCalled();
  });

  it("asks again for a threshold a tenth of the price, as «8» for «8к»", async () => {
    const result = await create({ below: 8, url: link }, [
      { content: `${link} напиши, когда будет 8`, role: "user" },
    ]);
    expect(result).toMatchObject({ watching: false });
    expect(JSON.stringify(result)).toContain("which amount they meant");
    expect(services.create).not.toHaveBeenCalled();
  });

  it("takes a term said in weeks or a month", async () => {
    await create({ days: 14, url: link }, [
      { content: `${link} следи 2 недели`, role: "user" },
    ]);
    await create({ days: 30, url: link }, [
      { content: `${link} следи месяц, пока не подешевеет`, role: "user" },
    ]);
    const terms = services.create.mock.calls.map(([, watch]) =>
      Math.round((watch.expiresAt.getTime() - Date.now()) / (24 * 60 * 60_000))
    );
    expect(terms).toEqual([14, 30]);
  });

  it("says a price exactly at the threshold has already come", async () => {
    services.page.mockResolvedValue({
      amount: 8_000,
      currency: "RUB",
      extractor: "jsonld",
      kind: "price",
      landedOn: "shop.example/p/kettle?color=black",
      name: "Чайник",
      sku: "K780",
    });
    const result = await create({ below: 8_000, url: link }, asked);
    expect(result).toMatchObject({ watching: false });
    expect(services.create).not.toHaveBeenCalled();
  });
});

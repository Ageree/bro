import type {
  OpenRouterChatSettings,
  OpenRouterProviderSettings,
} from "@openrouter/ai-sdk-provider";
import { APICallError, type wrapLanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { recordUsageCost } from "@db/services/usage-costs";
import type { directModelSelection } from "@agent/lib/model/direct";

type LanguageModelV4 = ReturnType<typeof wrapLanguageModel>;
type CallOptions = Parameters<LanguageModelV4["doGenerate"]>[0];

const openRouter = vi.hoisted(() => {
  const chat =
    vi.fn<
      (modelId: string, settings: OpenRouterChatSettings) => { modelId: string }
    >();
  return {
    chat,
    createOpenRouter:
      vi.fn<(options: OpenRouterProviderSettings) => { chat: typeof chat }>(),
  };
});
const costs = vi.hoisted(() => ({
  recordUsageCost: vi.fn<typeof recordUsageCost>(),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: openRouter.createOpenRouter,
}));
vi.mock("@db/services/usage-costs", () => ({
  recordUsageCost: costs.recordUsageCost,
}));

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  OPENROUTER_API_KEY: "openrouter-test-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

/** What the provider answers: a summary, at RouterAI's price in roubles. */
const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>(async () => ({
  content: [{ text: "Сводка разговора.", type: "text" }],
  finishReason: { raw: "stop", unified: "stop" },
  providerMetadata: { openrouter: { usage: { cost: 0.8441 } } },
  usage: {
    inputTokens: {
      cacheRead: 4_000,
      cacheWrite: undefined,
      noCache: 116_000,
      total: 120_000,
    },
    outputTokens: { reasoning: 300, text: 1_200, total: 1_500 },
  },
  warnings: [],
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("MODEL_PROVIDER", "routerai");
  vi.stubEnv("ROUTERAI_API_KEY", "routerai-test-key");
  vi.stubEnv("USAGE_USD_RUB", "84.41");
  openRouter.chat.mockImplementation((modelId) => ({
    doGenerate,
    doStream: vi.fn<LanguageModelV4["doStream"]>(),
    modelId,
    provider: "openrouter.chat",
    specificationVersion: "v4",
    supportedUrls: {},
  }));
  openRouter.createOpenRouter.mockReturnValue({ chat: openRouter.chat });
  costs.recordUsageCost.mockResolvedValue(true);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const owner = {
  runId: null,
  sessionId: "wrun_01",
  source: "chat" as const,
  turnId: "turn_7",
  workspaceId: "workspace-1",
};

/** eve's summary call: its own system prompt, one framework message, no tools. */
const compactionCall: CallOptions = {
  prompt: [
    {
      content:
        "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary…",
      role: "system",
    },
    {
      content: [{ text: "<conversation>…</conversation>", type: "text" }],
      role: "user",
    },
  ],
};

const stepCall: CallOptions = {
  prompt: [{ content: [{ text: "привет", type: "text" }], role: "user" }],
  tools: [
    {
      inputSchema: { properties: {}, type: "object" },
      name: "send_message",
      type: "function",
    },
  ],
};

async function selection(
  options: Partial<Parameters<typeof directModelSelection>[1]>
) {
  const { directModelSelection } = await import("@agent/lib/model/direct");
  return directModelSelection("deepseek/deepseek-v4.1-flash", {
    toolChoice: "auto",
    ...options,
  });
}

describe("the window a step of the compaction pilot reports to eve", () => {
  it("is the model's own outside the pilot and on a step that may not compact", async () => {
    expect((await selection({})).modelContextWindowTokens).toBe(1_048_576);
    expect(
      (await selection({ compaction: { cost: owner } }))
        .modelContextWindowTokens
    ).toBe(1_048_576);
  });

  it("puts eve's threshold at the input to compact at", async () => {
    const { modelContextWindowTokens } = await selection({
      compaction: { cost: owner, inputTokens: 150_000 },
    });
    expect(modelContextWindowTokens).toBe(214_286);
    expect(Math.floor(modelContextWindowTokens * 0.7)).toBe(150_000);
  });

  it("never reports more than the model's own window", async () => {
    vi.stubEnv("ROUTERAI_MODEL_CONTEXT_TOKENS", "180000");
    expect(
      (await selection({ compaction: { cost: owner, inputTokens: 150_000 } }))
        .modelContextWindowTokens
    ).toBe(180_000);
  });
});

describe("the cost of eve's compaction", () => {
  it("records each summary call once, priced as a step", async () => {
    const { model } = await selection({ compaction: { cost: owner } });
    await model.doGenerate(compactionCall);
    await model.doGenerate(compactionCall);
    await model.doGenerate({
      prompt: [...compactionCall.prompt, ...stepCall.prompt],
    });

    expect(costs.recordUsageCost).toHaveBeenCalledTimes(3);
    const [first, again, other] = costs.recordUsageCost.mock.calls.map(
      ([row]) => row
    );
    const { idempotencyKey, occurredAt, ...row } = first ?? {};
    expect(row).toEqual({
      // RouterAI's roubles, not dollars.
      costRub: 0.8441,
      costUsd: null,
      runId: null,
      sessionId: "wrun_01",
      source: "chat",
      units: {
        cachedInputTokens: 4_000,
        flavor: "compaction",
        inputTokens: 120_000,
        model: "deepseek/deepseek-v4.1-flash",
        outputTokens: 1_500,
        unpriced: false,
      },
      workspaceId: "workspace-1",
    });
    expect(idempotencyKey).toMatch(/^compaction:wrun_01:turn_7:[0-9a-f]{16}$/u);
    expect(occurredAt).toBeInstanceOf(Date);
    // The same call again collides on its key; another prompt does not.
    expect(again?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(other?.idempotencyKey).not.toBe(first?.idempotencyKey);
    expect(console.info).toHaveBeenCalledWith("[compaction]", {
      inputTokens: 120_000,
      outputTokens: 1_500,
      sessionId: "wrun_01",
      turnId: "turn_7",
    });
  });

  it("goes to the errand of a browser report's turn", async () => {
    const { model } = await selection({
      compaction: {
        cost: { ...owner, runId: "run-1", source: "browser-report" },
      },
    });
    await model.doGenerate(compactionCall);
    expect(costs.recordUsageCost).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", source: "browser-report" })
    );
  });

  it("leaves a model step to the step hook", async () => {
    const { model } = await selection({ compaction: { cost: owner } });
    await model.doGenerate(stepCall);
    expect(costs.recordUsageCost).not.toHaveBeenCalled();
  });

  it("records nothing outside the pilot", async () => {
    const { model } = await selection({});
    await model.doGenerate(compactionCall);
    expect(costs.recordUsageCost).not.toHaveBeenCalled();
  });

  it("keeps OpenRouter's call unpriced, as the hook keeps its steps", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openrouter");
    const { model } = await selection({ compaction: { cost: owner } });
    await model.doGenerate(compactionCall);

    expect(costs.recordUsageCost).toHaveBeenCalledTimes(1);
    const row = costs.recordUsageCost.mock.lastCall?.[0];
    expect(row?.costRub).toBe(0);
    expect(row?.costUsd).toBeNull();
    expect(row?.units?.unpriced).toBe(true);
  });

  it("never fails the compaction over its record", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    costs.recordUsageCost.mockRejectedValue(new Error("database is down"));
    const { model } = await selection({ compaction: { cost: owner } });

    const result = await model.doGenerate(compactionCall);
    expect(result.content).toEqual([
      { text: "Сводка разговора.", type: "text" },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[usage-costs] a cost could not be recorded",
      expect.objectContaining({ source: "chat" })
    );
  });
});

/** What the provider throws for a status, as AI SDK's handlers do. */
function statusError(statusCode: number) {
  return new APICallError({
    message: `HTTP ${String(statusCode)}`,
    requestBodyValues: {},
    statusCode,
    url: "https://routerai.ru/api/v1/chat/completions",
  });
}

describe("a failed summary call", () => {
  async function held() {
    const { compactionHeld } = await import("@agent/lib/compaction/call");
    return compactionHeld(owner.sessionId);
  }

  it("holds the session to its whole window, so its next turn does not fail too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { model } = await selection({ compaction: { cost: owner } });
    expect(await held()).toBe(false);
    doGenerate.mockRejectedValueOnce(new Error("Upstream error"));

    await expect(model.doGenerate(compactionCall)).rejects.toThrow(
      "Upstream error"
    );
    expect(await held()).toBe(true);
    expect(console.warn).toHaveBeenCalledWith("[compaction] failed", {
      cause: "Upstream error",
      sessionId: "wrun_01",
      turnId: "turn_7",
    });
    // Another session compacts as before.
    const { compactionHeld } = await import("@agent/lib/compaction/call");
    expect(compactionHeld("wrun_02")).toBe(false);
  });

  it("is an empty summary too, which eve throws on", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { model } = await selection({ compaction: { cost: owner } });
    doGenerate.mockResolvedValueOnce({
      content: [{ text: "  ", type: "text" }],
      finishReason: { raw: "content_filter", unified: "content-filter" },
      usage: {
        inputTokens: {
          cacheRead: 0,
          cacheWrite: undefined,
          noCache: 120_000,
          total: 120_000,
        },
        outputTokens: { reasoning: 0, text: 0, total: 0 },
      },
      warnings: [],
    });

    await model.doGenerate(compactionCall);
    expect(await held()).toBe(true);
    // Billed all the same.
    expect(costs.recordUsageCost).toHaveBeenCalledTimes(1);
  });

  it("is not an attempt AI SDK retries, until the last one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { model } = await selection({ compaction: { cost: owner } });

    // A 429, then the retry answers.
    doGenerate.mockRejectedValueOnce(statusError(429));
    await expect(model.doGenerate(compactionCall)).rejects.toThrow("HTTP 429");
    await model.doGenerate(compactionCall);
    expect(await held()).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    // A 503 on every one of the three attempts.
    const unavailable = async () => {
      doGenerate.mockRejectedValueOnce(statusError(503));
      await expect(model.doGenerate(compactionCall)).rejects.toThrow(
        "HTTP 503"
      );
      return held();
    };
    expect(await unavailable()).toBe(false);
    expect(await unavailable()).toBe(false);
    expect(await unavailable()).toBe(true);
  });

  it("is an error AI SDK does not retry, at once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { model } = await selection({ compaction: { cost: owner } });
    doGenerate.mockRejectedValueOnce(statusError(400));
    await expect(model.doGenerate(compactionCall)).rejects.toThrow("HTTP 400");
    expect(await held()).toBe(true);
  });

  it("is not a call the turn aborted, nor a step's", async () => {
    const { model } = await selection({ compaction: { cost: owner } });
    const aborted = new AbortController();
    aborted.abort();
    doGenerate.mockRejectedValueOnce(new Error("aborted"));
    await expect(
      model.doGenerate({ ...compactionCall, abortSignal: aborted.signal })
    ).rejects.toThrow("aborted");
    doGenerate.mockRejectedValueOnce(new Error("Upstream error"));
    await expect(model.doGenerate(stepCall)).rejects.toThrow("Upstream error");
    expect(await held()).toBe(false);
  });
});

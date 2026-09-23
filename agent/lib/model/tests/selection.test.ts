import type {
  OpenRouterChatSettings,
  OpenRouterProviderSettings,
} from "@openrouter/ai-sdk-provider";
import type { wrapLanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LanguageModelV4 = ReturnType<typeof wrapLanguageModel>;

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

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: openRouter.createOpenRouter,
}));

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  openRouter.chat.mockImplementation((modelId) => ({ modelId }));
  openRouter.createOpenRouter.mockReturnValue({ chat: openRouter.chat });
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  for (const name of [
    "OPENROUTER_MODEL_CONTEXT_TOKENS",
    "OPENROUTER_PROVIDER_ORDER",
    "OPENROUTER_REASONING_EFFORT",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("model selection", () => {
  it("keeps the gateway model id when no OpenRouter key is configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const { modelSelection } = await import("@agent/lib/model/selection");

    expect(modelSelection("openai/gpt-5.6-sol-fast")).toBe(
      "openai/gpt-5.6-sol-fast"
    );
    expect(openRouter.createOpenRouter).not.toHaveBeenCalled();
  });

  it("returns a direct OpenRouter model with an explicit context window", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "  openrouter-test-key\n");
    vi.stubEnv("OPENROUTER_MODEL_CONTEXT_TOKENS", "163840");

    const { modelSelection } = await import("@agent/lib/model/selection");
    const selection = modelSelection("deepseek/deepseek-v4.1-flash");

    expect(openRouter.createOpenRouter).toHaveBeenCalledExactlyOnceWith({
      apiKey: "openrouter-test-key",
      headers: {
        "HTTP-Referer": "https://openinstinct.example",
        "X-Title": "Bro",
      },
    });
    expect(openRouter.chat).toHaveBeenCalledExactlyOnceWith(
      "deepseek/deepseek-v4.1-flash",
      { provider: undefined }
    );
    expect(selection).toEqual({
      model: { modelId: "deepseek/deepseek-v4.1-flash" },
      modelContextWindowTokens: 163_840,
      modelOptions: {
        providerOptions: { openrouter: { reasoning: { enabled: false } } },
      },
    });
  });

  it("makes a step that must reach the person call a tool", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>();
    openRouter.chat.mockImplementation((modelId) => ({
      doGenerate,
      doStream: vi.fn<LanguageModelV4["doStream"]>(),
      modelId,
      provider: "openrouter.chat",
      specificationVersion: "v4",
      supportedUrls: {},
    }));

    const { openRouterSelection } = await import("@agent/lib/model/openrouter");
    const selection = openRouterSelection("deepseek/deepseek-v4.1-flash", {
      toolChoice: "required",
    });
    const sendMessage = {
      inputSchema: { type: "object" },
      name: "send_message",
      type: "function",
    } as const;
    await selection.model.doGenerate({ prompt: [], tools: [sendMessage] });
    await selection.model.doGenerate({ prompt: [] });

    expect(selection.model.modelId).toBe("deepseek/deepseek-v4.1-flash");
    expect(doGenerate.mock.calls[0]?.[0]).toMatchObject({
      toolChoice: { type: "required" },
    });
    // Compaction calls carry no tools, and `required` would reject them.
    expect(doGenerate.mock.calls[1]?.[0].toolChoice).toBeUndefined();
  });

  it("makes a looping turn end in text", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("OPENROUTER_REASONING_EFFORT", "medium");
    const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>();
    openRouter.chat.mockImplementation((modelId) => ({
      doGenerate,
      doStream: vi.fn<LanguageModelV4["doStream"]>(),
      modelId,
      provider: "openrouter.chat",
      specificationVersion: "v4",
      supportedUrls: {},
    }));

    const { openRouterSelection } = await import("@agent/lib/model/openrouter");
    // Anthropic rejects only a forced tool call while thinking, not `none`.
    const selection = openRouterSelection("anthropic/claude-sonnet-4.5", {
      toolChoice: "none",
    });
    await selection.model.doGenerate({
      prompt: [],
      tools: [
        {
          inputSchema: { type: "object" },
          name: "send_message",
          type: "function",
        },
      ],
    });

    expect(doGenerate.mock.calls[0]?.[0]).toMatchObject({
      toolChoice: { type: "none" },
    });
  });

  it.each([
    ["no tool call is required", "deepseek/deepseek-v4.1-flash", "auto", "off"],
    [
      "Anthropic thinks before answering",
      "anthropic/claude-sonnet-4.5",
      "required",
      "medium",
    ],
  ] as const)(
    "hands back the provider model untouched when %s",
    async (_case, modelId, toolChoice, effort) => {
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
      vi.stubEnv("OPENROUTER_REASONING_EFFORT", effort);
      const providerModel = { modelId };
      openRouter.chat.mockReturnValue(providerModel);

      const { openRouterSelection } =
        await import("@agent/lib/model/openrouter");
      const selection = openRouterSelection(modelId, { toolChoice });

      expect(selection.model).toBe(providerModel);
    }
  );

  it("pins the configured provider order and reasoning effort", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("OPENROUTER_PROVIDER_ORDER", " Baseten , fireworks ,, ");
    vi.stubEnv("OPENROUTER_REASONING_EFFORT", "MEDIUM");

    const { modelSelection } = await import("@agent/lib/model/selection");
    const selection = modelSelection("anthropic/claude-sonnet-4.5");

    expect(openRouter.chat).toHaveBeenCalledExactlyOnceWith(
      "anthropic/claude-sonnet-4.5",
      { provider: { order: ["baseten", "fireworks"] } }
    );
    expect(selection).toMatchObject({
      modelOptions: {
        providerOptions: { openrouter: { reasoning: { effort: "medium" } } },
      },
    });
  });
});

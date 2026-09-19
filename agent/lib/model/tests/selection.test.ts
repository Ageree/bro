import type {
  OpenRouterChatSettings,
  OpenRouterProviderSettings,
} from "@openrouter/ai-sdk-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

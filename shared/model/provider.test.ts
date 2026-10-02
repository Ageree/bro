import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("OPENROUTER_MODEL", "");
  vi.stubEnv("OPENROUTER_REASONING_EFFORT", "");
  vi.stubEnv("MODEL_PROVIDER", "");
  vi.stubEnv("ROUTERAI_API_KEY", "");
  vi.stubEnv("ROUTERAI_MODEL", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("model provider environment", () => {
  it("routes through the gateway default without an OpenRouter key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const { defaultModelId, directModelActive, directModelProviderName } =
      await import("@shared/model/provider");

    expect(directModelActive()).toBe(false);
    expect(directModelProviderName()).toBeUndefined();
    expect(defaultModelId()).toBe("openai/gpt-5.6-sol-fast");
  });

  it("trims a pasted key and defaults the OpenRouter model", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "  sk-or-test\n");

    const { env } = await import("@shared/environment");
    const { defaultModelId, directModelProvider, directModelProviderName } =
      await import("@shared/model/provider");

    expect(env.OPENROUTER_API_KEY).toBe("sk-or-test");
    // With MODEL_PROVIDER unset, the OpenRouter key alone selects OpenRouter.
    expect(directModelProvider()).toBe("openrouter");
    expect(directModelProviderName()).toBe("OpenRouter");
    expect(defaultModelId()).toBe("deepseek/deepseek-v4.1-flash");
    expect(env.OPENROUTER_MODEL_CONTEXT_TOKENS).toBe(1_000_000);
    expect(env.OPENROUTER_REASONING_EFFORT).toBe("low");
    expect(env.OPENROUTER_PROVIDER_ORDER).toBeUndefined();
  });

  it("uses the configured OpenRouter model as the workspace default", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_MODEL", " google/gemini-3-flash ");

    const { defaultModelId } = await import("@shared/model/provider");

    expect(defaultModelId()).toBe("google/gemini-3-flash");
  });

  it("selects RouterAI by MODEL_PROVIDER, though an OpenRouter key is set", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("MODEL_PROVIDER", " RouterAI ");
    vi.stubEnv("ROUTERAI_API_KEY", "“sk-rai-\ntest”");

    const { env } = await import("@shared/environment");
    const { defaultModelId, directModelProvider, directModelProviderName } =
      await import("@shared/model/provider");

    // A key pasted from a chat loses its quotes and line breaks.
    expect(env.ROUTERAI_API_KEY).toBe("sk-rai-test");
    expect(directModelProvider()).toBe("routerai");
    expect(directModelProviderName()).toBe("RouterAI");
    expect(defaultModelId()).toBe("deepseek/deepseek-v4.1-flash");
    expect(env.ROUTERAI_BASE_URL).toBe("https://routerai.ru/api/v1");
    expect(env.ROUTERAI_MODEL_CONTEXT_TOKENS).toBe(1_048_576);
    expect(env.ROUTERAI_REASONING_EFFORT).toBe("low");
  });

  it("uses the configured RouterAI model as the workspace default", async () => {
    vi.stubEnv("MODEL_PROVIDER", "routerai");
    vi.stubEnv("ROUTERAI_API_KEY", "sk-rai-test");
    vi.stubEnv("ROUTERAI_MODEL", " deepseek/deepseek-v4-flash ");

    const { defaultModelId } = await import("@shared/model/provider");

    expect(defaultModelId()).toBe("deepseek/deepseek-v4-flash");
  });

  it("refuses a provider chosen without its key", async () => {
    vi.stubEnv("MODEL_PROVIDER", "routerai");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({
        message: "MODEL_PROVIDER=routerai needs ROUTERAI_API_KEY",
      }),
    ]);

    vi.resetModules();
    vi.stubEnv("MODEL_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ROUTERAI_API_KEY", "sk-rai-test");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("sends the RouterAI key only over https", async () => {
    vi.stubEnv("MODEL_PROVIDER", "routerai");
    vi.stubEnv("ROUTERAI_API_KEY", "sk-rai-test");
    vi.stubEnv("ROUTERAI_BASE_URL", "http://routerai.ru/api/v1");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({
        message: "ROUTERAI_BASE_URL must be an absolute https URL",
      }),
    ]);
  });

  it("rejects an unknown provider", async () => {
    vi.stubEnv("MODEL_PROVIDER", "gateway");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("rejects an output cap that is not a positive whole number", async () => {
    vi.stubEnv("OPENROUTER_MAX_OUTPUT_TOKENS", "0");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });

  it("rejects an unsupported reasoning effort", async () => {
    vi.stubEnv("OPENROUTER_REASONING_EFFORT", "extreme");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });
});

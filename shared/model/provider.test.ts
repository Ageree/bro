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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("model provider environment", () => {
  it("routes through the gateway default without an OpenRouter key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const { defaultModelId, openRouterActive } =
      await import("@shared/model/provider");

    expect(openRouterActive()).toBe(false);
    expect(defaultModelId()).toBe("openai/gpt-5.6-sol-fast");
  });

  it("trims a pasted key and defaults the OpenRouter model", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "  sk-or-test\n");

    const { env } = await import("@shared/environment");
    const { defaultModelId, openRouterActive } =
      await import("@shared/model/provider");

    expect(env.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(openRouterActive()).toBe(true);
    expect(defaultModelId()).toBe("deepseek/deepseek-v4.1-flash");
    expect(env.OPENROUTER_MODEL_CONTEXT_TOKENS).toBe(1_000_000);
    expect(env.OPENROUTER_REASONING_EFFORT).toBe("off");
    expect(env.OPENROUTER_PROVIDER_ORDER).toBeUndefined();
  });

  it("uses the configured OpenRouter model as the workspace default", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_MODEL", " google/gemini-3-flash ");

    const { defaultModelId } = await import("@shared/model/provider");

    expect(defaultModelId()).toBe("google/gemini-3-flash");
  });

  it("rejects an unsupported reasoning effort", async () => {
    vi.stubEnv("OPENROUTER_REASONING_EFFORT", "extreme");

    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });
});

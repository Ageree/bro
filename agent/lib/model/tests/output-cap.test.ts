import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const network = vi.hoisted(() => ({
  fetch:
    vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(),
}));

vi.mock("@agent/lib/model/stream-watchdog", () => ({
  watchedModelFetch: network.fetch,
}));

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  OPENROUTER_API_KEY: "openrouter-test-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

function completion() {
  return Response.json({
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: { content: "Готово.", role: "assistant" },
      },
    ],
    created: 0,
    id: "gen-test",
    model: "deepseek/deepseek-v4.1-flash",
    object: "chat.completion",
    usage: { completion_tokens: 2, prompt_tokens: 10, total_tokens: 12 },
  });
}

const sentBodySchema = z.looseObject({
  max_tokens: z.number().optional(),
  model: z.string(),
  reasoning: z.unknown(),
});

/** The chat completions body of the one request the step sent. */
function sentBody() {
  expect(network.fetch).toHaveBeenCalledOnce();
  const body = z.string().parse(network.fetch.mock.calls[0]?.[1]?.body);
  return sentBodySchema.parse(JSON.parse(body));
}

async function runStep(
  modelId: string,
  options: { readonly maxOutputTokens?: number } = {}
) {
  const { openRouterSelection } = await import("@agent/lib/model/openrouter");
  const selection = openRouterSelection(modelId, { toolChoice: "auto" });
  await generateText({
    maxOutputTokens: options.maxOutputTokens,
    model: selection.model,
    prompt: "Напиши короткое письмо.",
    providerOptions: selection.modelOptions.providerOptions,
  });
  return sentBody();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  network.fetch.mockImplementation(async () => completion());
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  for (const name of [
    "OPENROUTER_MAX_OUTPUT_TOKENS",
    "OPENROUTER_PROVIDER_ORDER",
    "OPENROUTER_REASONING_EFFORT",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenRouter output cap", () => {
  it("caps a normal step at 16,384 tokens", async () => {
    const body = await runStep("deepseek/deepseek-v4.1-flash");

    expect(body).toMatchObject({
      max_tokens: 16_384,
      model: "deepseek/deepseek-v4.1-flash",
      reasoning: { enabled: false },
    });
  });

  it("gives a reasoning step room for its thinking", async () => {
    vi.stubEnv("OPENROUTER_REASONING_EFFORT", "high");

    const body = await runStep("anthropic/claude-sonnet-5");

    expect(body).toMatchObject({
      max_tokens: 32_768,
      model: "anthropic/claude-sonnet-5",
      reasoning: { effort: "high" },
    });
  });

  it("takes the configured cap", async () => {
    vi.stubEnv("OPENROUTER_MAX_OUTPUT_TOKENS", "4096");
    vi.stubEnv("OPENROUTER_REASONING_EFFORT", "medium");

    const body = await runStep("deepseek/deepseek-v4.1-flash");

    expect(body.max_tokens).toBe(4096);
  });

  it("keeps a smaller limit the caller set and lowers a larger one", async () => {
    expect(
      (await runStep("deepseek/deepseek-v4.1-flash", { maxOutputTokens: 800 }))
        .max_tokens
    ).toBe(800);

    vi.clearAllMocks();
    expect(
      (
        await runStep("deepseek/deepseek-v4.1-flash", {
          maxOutputTokens: 131_072,
        })
      ).max_tokens
    ).toBe(16_384);
  });
});

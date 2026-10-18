import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const network = vi.hoisted(() => ({
  // Every model call of a step, to RouterAI or RunInfra.
  step: vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(),
}));

vi.mock("@agent/lib/model/stream-watchdog", () => ({
  watchedModelFetch: network.step,
}));

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://bro.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  MODEL_PROVIDER: "routerai",
  ROUTERAI_API_KEY: "routerai-test-key",
  ROUTERAI_BASE_URL: "https://routerai.test/api/v1",
  RUNINFRA_API_KEY: "runinfra-test-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  USAGE_USD_RUB: "80",
};

const runInfraUrl = "https://api.runinfra.ai/v1/chat/completions";
const minutes = (count: number) => count * 60_000;

function completion(cached = 0) {
  return Response.json({
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: { content: "Готово.", role: "assistant" },
      },
    ],
    created: 0,
    id: "ri-test",
    model: "deepseek-v4-1-flash",
    object: "chat.completion",
    usage: {
      completion_tokens: 2,
      cost: 0.0013,
      prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: cached },
      total_tokens: 12,
    },
  });
}

const pingSchema = z.looseObject({
  max_tokens: z.number(),
  messages: z.array(z.looseObject({ content: z.string(), role: z.string() })),
  model: z.string(),
  stream: z.boolean(),
  tool_choice: z.string(),
});

/** The pings sent so far, as RunInfra got them. */
function pings(sent: ReturnType<typeof vi.fn<typeof fetch>>) {
  return sent.mock.calls.map(([input, init]) => ({
    body: pingSchema.parse(JSON.parse(z.string().parse(init?.body))),
    url: input instanceof Request ? input.url : input.toString(),
  }));
}

async function step(words: string, warmConversation?: string) {
  const { directModelSelection } = await import("@agent/lib/model/direct");
  const selection = directModelSelection("deepseek/deepseek-v4.1-flash", {
    toolChoice: "auto",
    warmConversation,
  });
  await generateText({
    model: selection.model,
    prompt: words,
    providerOptions: selection.modelOptions.providerOptions,
  });
}

/** Where the steps' calls went. */
function stepUrls() {
  return network.step.mock.calls.map(([input]) =>
    input instanceof Request ? input.url : input.toString()
  );
}

let pinged: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  network.step.mockImplementation(async () => completion());
  pinged = vi.fn<typeof fetch>(async () => completion(9));
  vi.stubGlobal("fetch", pinged);
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // tests/setup-env.ts leaves these unset; `vi.unstubAllEnvs()` would drop
  // its stubs too.
  for (const name of Object.keys(requiredEnvironment)) vi.stubEnv(name, "");
});

describe("a person's prompt kept in RunInfra's cache", () => {
  it("goes again for one token after each 40 quiet minutes, three times", async () => {
    await step("Привет, как дела?", "session-1");
    expect(stepUrls()).toEqual([runInfraUrl]);

    await vi.advanceTimersByTimeAsync(minutes(39));
    expect(pinged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(minutes(1));
    expect(pings(pinged)).toHaveLength(1);
    expect(pings(pinged)[0]).toMatchObject({
      body: {
        max_tokens: 1,
        messages: [{ content: "Привет, как дела?", role: "user" }],
        model: "deepseek-v4-1-flash",
        stream: false,
        tool_choice: "auto",
      },
      url: runInfraUrl,
    });

    await vi.advanceTimersByTimeAsync(minutes(4 * 40));
    expect(pinged).toHaveBeenCalledTimes(3);
    // Only the pings went out: no step called the model again.
    expect(stepUrls()).toEqual([runInfraUrl]);
  });

  it("waits again from the conversation's newer call", async () => {
    await step("Привет", "session-1");
    await vi.advanceTimersByTimeAsync(minutes(30));
    await step("А что завтра?", "session-1");

    await vi.advanceTimersByTimeAsync(minutes(39));
    expect(pinged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(minutes(1));
    expect(pings(pinged).map((ping) => ping.body.messages)).toEqual([
      [{ content: "А что завтра?", role: "user" }],
    ]);
  });

  it("is never pinged for a call outside a person's conversation", async () => {
    await step("Proactive check");

    await vi.advanceTimersByTimeAsync(minutes(4 * 40));
    expect(pinged).not.toHaveBeenCalled();
  });

  it("stops after a failed ping, which keeps no step off RunInfra", async () => {
    pinged.mockRejectedValue(new TypeError("fetch failed"));
    await step("Привет", "session-1");

    await vi.advanceTimersByTimeAsync(minutes(4 * 40));
    expect(pinged).toHaveBeenCalledOnce();
    await step("Ты тут?");
    expect(stepUrls()).toEqual([runInfraUrl, runInfraUrl]);
  });
});

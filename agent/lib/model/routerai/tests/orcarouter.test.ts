import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const requiredEnvironment = {
  BEATAPI_API_KEY: "beatapi-test-key",
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://bro.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  MODEL_PROVIDER: "routerai",
  ORCAROUTER_API_KEY: "orca-test-key",
  ROUTERAI_API_KEY: "routerai-test-key",
  ROUTERAI_BASE_URL: "https://routerai.test/api/v1",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  USAGE_USD_RUB: "80",
};

const routerAiUrl = "https://routerai.test/api/v1/chat/completions";
const orcaUrl = "https://api.orcarouter.ai/v1/chat/completions";
const beatApiUrl = "https://api.beatapi.io/v1/chat/completions";

const call = {
  body: JSON.stringify({
    messages: [{ content: "Привет", role: "user" }],
    model: "deepseek/deepseek-v4.1-flash",
    reasoning: { enabled: false },
    stream: false,
    tool_choice: "required",
    tools: [
      {
        function: { name: "send_message", parameters: { type: "object" } },
        type: "function",
      },
    ],
  }),
  headers: { authorization: "Bearer routerai-test-key" },
  method: "POST",
};

/** An answer as OrcaRouter sends it: tokens only, the cache in the details. */
const orcaAnswer = JSON.stringify({
  choices: [
    {
      finish_reason: "tool_calls",
      index: 0,
      message: {
        role: "assistant",
        tool_calls: [{ id: "c", type: "function" }],
      },
    },
  ],
  usage: {
    completion_tokens: 1_000,
    prompt_tokens: 1_000_000,
    prompt_tokens_details: { cached_tokens: 900_000 },
  },
});

function network(answers: Record<string, readonly (Response | Error)[]>) {
  const pending = new Map(
    Object.entries(answers).map(([url, list]) => [url, [...list]])
  );
  const sent: { readonly messages: number; readonly url: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      sent.push({
        messages: z
          .looseObject({ messages: z.array(z.json()) })
          .parse(JSON.parse(z.string().parse(init?.body))).messages.length,
        url,
      });
      const answer = pending.get(url)?.shift();
      if (answer === undefined) throw new Error(`No answer is left: ${url}`);
      if (answer instanceof Error) throw answer;
      return Promise.resolve(answer);
    })
  );
  return sent;
}

beforeEach(() => {
  vi.resetModules();
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function modelFetch() {
  const { routerAiModelFetch } =
    await import("@agent/lib/model/routerai/fetch");
  return routerAiModelFetch;
}

describe("a chat call for a model OrcaRouter hosts", () => {
  it("goes to OrcaRouter first, forced as it is, its tokens priced in roubles", async () => {
    const sent = network({ [orcaUrl]: [new Response(orcaAnswer)] });

    const text = await (await (await modelFetch())(routerAiUrl, call)).text();

    // Its model obeys tool_choice: no note is added to the messages.
    expect(sent).toEqual([{ messages: 1, url: orcaUrl }]);
    // 100k missed at $0.15, 900k cached at $0.003, 1k out at $0.60 per
    // million: $0.0183 at 80 ₽ per dollar.
    const cost = z
      .object({ usage: z.object({ cost: z.number() }) })
      .parse(JSON.parse(text)).usage.cost;
    expect(cost).toBeCloseTo(0.0183 * 80, 6);
  });

  it("falls to BeatAPI when OrcaRouter fails", async () => {
    const sent = network({
      [beatApiUrl]: [
        new Response(
          JSON.stringify({
            choices: [{ message: { tool_calls: [{ id: "c" }] } }],
            usage: {
              completion_tokens: 1,
              prompt_cache_hit_tokens: 0,
              prompt_cache_miss_tokens: 2,
              prompt_tokens: 2,
            },
          })
        ),
      ],
      [orcaUrl]: [new Response("{}", { status: 503 })],
    });

    await (await (await modelFetch())(routerAiUrl, call)).text();

    expect(sent.map(({ url }) => url)).toEqual([orcaUrl, beatApiUrl]);
    // BeatAPI does not force a tool, so it was told to call one.
    expect(sent[1]?.messages).toBe(2);
  });
});

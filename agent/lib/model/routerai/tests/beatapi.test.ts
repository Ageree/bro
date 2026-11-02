import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const requiredEnvironment = {
  BEATAPI_API_KEY: "beatapi-test-key",
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

const routerAiUrl = "https://routerai.test/api/v1/chat/completions";
const runInfraUrl = "https://api.runinfra.ai/v1/chat/completions";
const beatApiUrl = "https://api.beatapi.io/v1/chat/completions";

function call(
  extra: {
    readonly plugins?: readonly string[];
    readonly toolChoice?: string;
  } = {}
) {
  return {
    body: JSON.stringify({
      messages: [{ content: "Привет", role: "user" }],
      model: "deepseek/deepseek-v4.1-flash",
      plugins: extra.plugins?.map((id) => ({ id })),
      reasoning: { enabled: false },
      stream: true,
      tool_choice: extra.toolChoice,
      tools: [
        {
          function: { name: "send_message", parameters: { type: "object" } },
          type: "function",
        },
      ],
      usage: { include: true },
    }),
    headers: { authorization: "Bearer routerai-test-key" },
    method: "POST",
  };
}

/** A stream as BeatAPI sends it: tokens in `usage`, no cost, no `[DONE]` gaps. */
const beatStream = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, index: 0 }], id: "b" })}\n\n`,
  `data: ${JSON.stringify({
    choices: [],
    id: "b",
    usage: {
      completion_tokens: 1_000,
      prompt_cache_hit_tokens: 900_000,
      prompt_cache_miss_tokens: 100_000,
      prompt_tokens: 1_000_000,
    },
  })}\n\n`,
  "data: [DONE]\n\n",
].join("");

function streamed(text: string, status = 200) {
  return new Response(text, {
    headers: { "content-type": "text/event-stream" },
    status,
  });
}

type Answer = Response | Error;

function network(answers: {
  readonly beat?: readonly Answer[];
  readonly router?: readonly Answer[];
  readonly runInfra?: readonly Answer[];
}) {
  const pending = new Map<string, Answer[]>([
    [beatApiUrl, [...(answers.beat ?? [])]],
    [routerAiUrl, [...(answers.router ?? [])]],
    [runInfraUrl, [...(answers.runInfra ?? [])]],
  ]);
  const sent: { readonly model: string; readonly url: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      sent.push({
        model: z
          .looseObject({ model: z.string() })
          .parse(JSON.parse(z.string().parse(init?.body))).model,
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

async function modelFetch() {
  const { routerAiModelFetch } =
    await import("@agent/lib/model/routerai/fetch");
  return routerAiModelFetch;
}

function backends(sent: ReturnType<typeof network>) {
  return sent.map(({ url }) =>
    url === beatApiUrl
      ? "beatapi"
      : url === runInfraUrl
        ? "runinfra"
        : "routerai"
  );
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("a chat call for a model BeatAPI hosts", () => {
  it("does not go to BeatAPI when it forces a tool, which BeatAPI ignores", async () => {
    const sent = network({ router: [new Response("{}", { status: 200 })] });
    const fetchModel = await modelFetch();

    await fetchModel(routerAiUrl, call({ toolChoice: "required" }));

    expect(backends(sent)).not.toContain("beatapi");
  });

  it("goes to BeatAPI first with its model id, and its usage is priced in roubles", async () => {
    const sent = network({ beat: [streamed(beatStream)] });

    const text = await (
      await (
        await modelFetch()
      )(routerAiUrl, call({ toolChoice: "auto" }))
    ).text();

    expect(sent).toEqual([{ model: "deepseek-v4.1-flash", url: beatApiUrl }]);
    // 100k missed at $0.075, 900k cached at $0.0015, 1k out at $0.30 per
    // million: $0.00915 at 80 ₽ per dollar.
    const usage = text
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) =>
        z
          .object({ usage: z.object({ cost: z.number() }).optional() })
          .parse(JSON.parse(line.slice(6)))
      )
      .find((event) => event.usage !== undefined)?.usage;
    expect(usage?.cost).toBeCloseTo(0.00915 * 80, 6);
  });

  it("falls to RunInfra on a failure and skips BeatAPI for the next calls", async () => {
    const sent = network({
      beat: [streamed("{}", 503)],
      runInfra: [
        streamed(
          'data: {"choices":[],"usage":{"completion_tokens":1,"cost":0.001,"prompt_tokens":2}}\n\ndata: [DONE]\n\n'
        ),
        streamed(
          'data: {"choices":[],"usage":{"completion_tokens":1,"cost":0.001,"prompt_tokens":2}}\n\ndata: [DONE]\n\n'
        ),
      ],
    });
    const fetchModel = await modelFetch();

    await (await fetchModel(routerAiUrl, call({ toolChoice: "auto" }))).text();
    await (await fetchModel(routerAiUrl, call({ toolChoice: "auto" }))).text();

    expect(backends(sent)).toEqual(["beatapi", "runinfra", "runinfra"]);
  });

  it("treats an error inside the answer as a failure", async () => {
    const sent = network({
      beat: [streamed('data: {"error":{"message":"boom"}}\n\n')],
      runInfra: [
        streamed(
          'data: {"choices":[],"usage":{"completion_tokens":1,"cost":0.001,"prompt_tokens":2}}\n\ndata: [DONE]\n\n'
        ),
      ],
    });

    await (
      await (
        await modelFetch()
      )(routerAiUrl, call({ toolChoice: "auto" }))
    ).text();

    expect(backends(sent)).toEqual(["beatapi", "runinfra"]);
  });

  it("leaves a call with web search to the next backend", async () => {
    const sent = network({
      runInfra: [],
      router: [new Response("{}", { status: 200 })],
    });

    await (
      await modelFetch()
    )(routerAiUrl, call({ plugins: ["web"] }));

    expect(backends(sent)).toEqual(["routerai"]);
  });
});

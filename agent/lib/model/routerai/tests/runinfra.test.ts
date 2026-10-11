import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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

const routerAiUrl = "https://routerai.test/api/v1/chat/completions";
const runInfraUrl = "https://api.runinfra.ai/v1/chat/completions";

/** A chat call as the provider package sends it to RouterAI for Bro. */
function routerAiCall(
  extra: {
    readonly model?: string;
    readonly plugins?: readonly string[];
    readonly reasoning?: {
      readonly effort?: string;
      readonly enabled?: boolean;
    };
  } = {}
) {
  return {
    body: JSON.stringify({
      include_reasoning: false,
      max_tokens: 32_768,
      messages: [{ content: "Привет", role: "user" }],
      model: extra.model ?? "deepseek/deepseek-v4.1-flash",
      plugins: extra.plugins?.map((id) => ({ id })),
      provider: { ignore: ["deepseek"], order: ["deepinfra"] },
      reasoning: extra.reasoning ?? { effort: "low" },
      stream: true,
      temperature: 0.3,
      tool_choice: "required",
      tools: [
        {
          function: { name: "send_message", parameters: { type: "object" } },
          type: "function",
        },
      ],
      usage: { include: true },
    }),
    headers: {
      authorization: "Bearer routerai-test-key",
      "content-type": "application/json",
    },
    method: "POST",
  };
}

/** One event of an OpenAI-compatible stream, as the tests send it. */
interface StreamChunk {
  readonly choices?: readonly {
    readonly delta: { readonly content?: string };
    readonly finish_reason?: string;
    readonly index: number;
  }[];
  readonly error?: { readonly code: number; readonly message: string };
  readonly id?: string;
  readonly usage?: {
    readonly completion_tokens: number;
    readonly cost: number;
    readonly prompt_tokens: number;
    readonly prompt_tokens_details: { readonly cached_tokens: number };
  };
}

function chunk(value: StreamChunk) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

/** A streamed answer as RunInfra sends it: usage last, cost in dollars. */
function runInfraStream(text: string, costUsd = 0.0013) {
  return [
    chunk({ choices: [{ delta: { content: text }, index: 0 }], id: "ri-1" }),
    chunk({
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      id: "ri-1",
    }),
    chunk({
      choices: [],
      id: "ri-1",
      usage: {
        completion_tokens: 2,
        cost: costUsd,
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 8 },
      },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

function streamed(text: string, status = 200) {
  return new Response(text, {
    headers: { "content-type": "text/event-stream" },
    status,
  });
}

type Answer = Response | Error;

const sentSchema = z.looseObject({
  model: z.string(),
});

/** The next answers of RouterAI and of RunInfra, and what each call sent. */
function network(
  routerAi: readonly Answer[],
  runInfra: readonly Answer[] = []
) {
  const pending = { routerAi: [...routerAi], runInfra: [...runInfra] };
  const sent: {
    readonly authorization: string | null;
    readonly body: z.infer<typeof sentSchema>;
    readonly url: string;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      sent.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: sentSchema.parse(JSON.parse(z.string().parse(init?.body))),
        url,
      });
      const answer = (
        url === runInfraUrl ? pending.runInfra : pending.routerAi
      ).shift();
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

function urls(sent: ReturnType<typeof network>) {
  return sent.map((call) =>
    call.url === runInfraUrl ? "runinfra" : "routerai"
  );
}

const usageSchema = z.object({ usage: z.object({ cost: z.number() }) });

/** The cost the last usage chunk of a stream carries. */
function streamedCost(text: string) {
  const lines = text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => usageSchema.safeParse(JSON.parse(line.slice(6))).data)
    .filter((answer) => answer !== undefined);
  return lines.at(-1)?.usage.cost;
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

describe("a chat call for a model RunInfra hosts", () => {
  it("goes to RunInfra with its model id and OpenAI's fields only, cost in roubles", async () => {
    const sent = network([], [streamed(runInfraStream("Канберра"))]);

    const response = await (await modelFetch())(routerAiUrl, routerAiCall());
    const text = await response.text();

    expect(urls(sent)).toEqual(["runinfra"]);
    expect(sent[0]).toEqual({
      authorization: "Bearer runinfra-test-key",
      body: {
        max_tokens: 32_768,
        messages: [{ content: "Привет", role: "user" }],
        model: "deepseek-v4-1-flash",
        reasoning_effort: "low",
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.3,
        tool_choice: "required",
        tools: [
          {
            function: { name: "send_message", parameters: { type: "object" } },
            type: "function",
          },
        ],
      },
      url: runInfraUrl,
    });
    expect(text).toContain("Канберра");
    // $0.0013 at 80 ₽ per dollar: what the rest of Bro reads as roubles.
    expect(streamedCost(text)).toBeCloseTo(0.104, 6);
  });

  it("asks RunInfra for no reasoning when the step runs without it", async () => {
    const sent = network([], [streamed(runInfraStream("Да"))]);

    await (
      await modelFetch()
    )(routerAiUrl, routerAiCall({ reasoning: { enabled: false } }));

    expect(sent[0]?.body).toMatchObject({ reasoning_effort: "none" });
  });

  it.each([
    ["a gateway failure", () => streamed("Service Unavailable", 503)],
    ["a refusal", () => streamed('{"error":{"message":"bad"}}', 400)],
    [
      "an error inside the stream",
      () =>
        streamed(
          `${chunk({ choices: [{ delta: { content: "Ка" }, index: 0 }] })}${chunk({ error: { code: 500, message: "upstream" } })}`
        ),
    ],
    ["a network error", () => new TypeError("fetch failed")],
  ])(
    "goes to RouterAI on %s, and skips RunInfra after that",
    async (_, failure) => {
      const sent = network(
        [streamed(runInfraStream("Канберра")), streamed(runInfraStream("Да"))],
        [failure()]
      );
      const send = await modelFetch();

      const first = await send(routerAiUrl, routerAiCall());
      expect(await first.text()).toContain("Канберра");
      await (await send(routerAiUrl, routerAiCall())).text();

      expect(urls(sent)).toEqual(["runinfra", "routerai", "routerai"]);
    }
  );

  it("tries RunInfra again five minutes after it failed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sent = network(
      [streamed(runInfraStream("Да"))],
      [new TypeError("fetch failed"), streamed(runInfraStream("Снова"))]
    );
    const send = await modelFetch();

    await (await send(routerAiUrl, routerAiCall())).text();
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    const again = await send(routerAiUrl, routerAiCall());

    expect(await again.text()).toContain("Снова");
    expect(urls(sent)).toEqual(["runinfra", "routerai", "runinfra"]);
  });
});

describe("calls RunInfra does not serve stay on RouterAI", () => {
  it("a call with plugins (web search)", async () => {
    const sent = network([streamed(runInfraStream("Да"))]);

    await (
      await modelFetch()
    )(routerAiUrl, routerAiCall({ plugins: ["web"] }));

    expect(urls(sent)).toEqual(["routerai"]);
  });

  it("a model RunInfra does not host", async () => {
    const sent = network([streamed(runInfraStream("Да"))]);

    await (
      await modelFetch()
    )(routerAiUrl, routerAiCall({ model: "openai/gpt-6-luna" }));

    expect(urls(sent)).toEqual(["routerai"]);
  });

  it("every call without RUNINFRA_API_KEY", async () => {
    vi.stubEnv("RUNINFRA_API_KEY", "");
    const sent = network([streamed(runInfraStream("Да"))]);

    await (
      await modelFetch()
    )(routerAiUrl, routerAiCall());

    expect(urls(sent)).toEqual(["routerai"]);
  });
});

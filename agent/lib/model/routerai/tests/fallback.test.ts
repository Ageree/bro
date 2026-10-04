import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://bro.example",
  CLOUDRU_FM_API_KEY: "fm-test-key",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  MODEL_PROVIDER: "routerai",
  ROUTERAI_API_KEY: "routerai-test-key",
  ROUTERAI_BASE_URL: "https://routerai.test/api/v1",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

const routerAiUrl = "https://routerai.test/api/v1/chat/completions";
const foundationModelsUrl =
  "https://foundation-models.api.cloud.ru/v1/chat/completions";

/** A chat call as the provider package sends it to RouterAI for Bro. */
function routerAiCall(extra: { readonly plugins?: readonly string[] } = {}) {
  return {
    body: JSON.stringify({
      include_reasoning: false,
      max_tokens: 32_768,
      messages: [{ content: "Привет", role: "user" }],
      model: "deepseek/deepseek-v4.1-flash",
      models: ["deepseek/deepseek-v4-flash"],
      plugins: extra.plugins?.map((id) => ({ id })),
      provider: { ignore: ["deepseek"], order: ["deepinfra"] },
      reasoning: { effort: "low" },
      route: "fallback",
      stream: true,
      temperature: 0.3,
      tool_choice: "required",
      tools: [
        {
          function: { name: "send_message", parameters: { type: "object" } },
          type: "function",
        },
      ],
      top_k: 40,
      transforms: ["middle-out"],
      usage: { include: true },
    }),
    headers: {
      authorization: "Bearer routerai-test-key",
      "content-type": "application/json",
    },
    method: "POST",
  };
}

/** A streamed answer as an OpenAI-compatible server sends it, usage last. */
function openAiStream(text: string) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text, role: "assistant" }, index: 0 }], id: "fm-1" })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], id: "fm-1" })}\n\n`,
    `data: ${JSON.stringify({ choices: [], id: "fm-1", usage: { completion_tokens: 2, prompt_tokens: 10, total_tokens: 12 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function streamed(text: string, status = 200) {
  return new Response(text, {
    headers: { "content-type": "text/event-stream" },
    status,
  });
}

function failed(status: number, message: string) {
  return new Response(JSON.stringify({ error: { code: status, message } }), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/** The network error undici's `fetch` throws for a connect timeout. */
function connectTimeout() {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    }),
  });
}

type Answer = Response | Error;

const sentSchema = z.looseObject({
  model: z.string().optional(),
  provider: z.unknown().optional(),
});

/**
 * The next answers of RouterAI and of Foundation Models, one per call each,
 * and what each call sent.
 */
function network(routerAi: readonly Answer[], foundationModels: Answer[] = []) {
  const pending = { fm: [...foundationModels], routerAi: [...routerAi] };
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
        url === foundationModelsUrl ? pending.fm : pending.routerAi
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
    call.url === foundationModelsUrl ? "cloudru-fm" : "routerai"
  );
}

const warn = vi.fn<typeof console.warn>();
const info = vi.fn<typeof console.info>();

beforeEach(() => {
  vi.resetModules();
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.spyOn(console, "warn").mockImplementation(warn);
  vi.spyOn(console, "info").mockImplementation(info);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  warn.mockReset();
  info.mockReset();
});

describe("a chat call RouterAI's route failed", () => {
  it("goes to Foundation Models without OpenRouter's fields, and its answer is passed on", async () => {
    const sent = network([connectTimeout()], [streamed(openAiStream("Да"))]);

    const response = await (await modelFetch())(routerAiUrl, routerAiCall());

    expect(await response.text()).toBe(openAiStream("Да"));
    expect(urls(sent)).toEqual(["routerai", "cloudru-fm"]);
    expect(sent[1]).toEqual({
      authorization: "Bearer fm-test-key",
      body: {
        max_tokens: 32_768,
        messages: [{ content: "Привет", role: "user" }],
        model: "deepseek-ai/DeepSeek-V4.1-Flash",
        stream: true,
        // Token counts of a stream come only when asked for.
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
      url: foundationModelsUrl,
    });
    expect(warn).toHaveBeenCalledWith("[model] fallback cloudru-fm on", {
      probe: false,
      reason: "UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error",
    });
  });

  it.each([500, 502, 503, 504])(
    "goes to Foundation Models on a gateway failure (%i)",
    async (status) => {
      const sent = network(
        [failed(status, "Service Unavailable")],
        [streamed(openAiStream("Да"))]
      );

      const response = await (await modelFetch())(routerAiUrl, routerAiCall());

      expect(response.status).toBe(200);
      expect(urls(sent)).toEqual(["routerai", "cloudru-fm"]);
    }
  );

  it("goes to Foundation Models on a 5xx RouterAI sends inside an HTTP 200", async () => {
    const sent = network(
      [
        streamed(
          `data: ${JSON.stringify({ error: { code: 503, message: "Service temporarily unavailable" } })}\n\ndata: [DONE]\n\n`
        ),
      ],
      [streamed(openAiStream("Да"))]
    );

    const response = await (await modelFetch())(routerAiUrl, routerAiCall());

    expect(await response.text()).toBe(openAiStream("Да"));
    expect(urls(sent)).toEqual(["routerai", "cloudru-fm"]);
  });

  it("gets RouterAI's own failure when Foundation Models fails too", async () => {
    const sent = network(
      [failed(503, "Service Unavailable")],
      [failed(401, "invalid api key secret")]
    );

    const response = await (await modelFetch())(routerAiUrl, routerAiCall());

    // The outage, as eve and «скоро вернусь» know it.
    expect(response.status).toBe(503);
    expect(urls(sent)).toEqual(["routerai", "cloudru-fm"]);
  });

  it("throws RouterAI's network error when Foundation Models fails too", async () => {
    const error = connectTimeout();
    network([error], [new TypeError("fetch failed")]);

    await expect(
      (await modelFetch())(routerAiUrl, routerAiCall())
    ).rejects.toBe(error);
  });
});

describe("a chat call that does not fall back", () => {
  it.each([400, 401, 402])(
    "is a refusal: a bad request, a bad key, no credit (%i)",
    async (status) => {
      const sent = network([failed(status, "Refused")]);

      const response = await (await modelFetch())(routerAiUrl, routerAiCall());

      expect(response.status).toBe(status);
      expect(urls(sent)).toEqual(["routerai"]);
    }
  );

  it("is made without a Foundation Models key", async () => {
    vi.stubEnv("CLOUDRU_FM_API_KEY", "");
    const sent = network([
      failed(503, "Service Unavailable"),
      connectTimeout(),
    ]);
    const send = await modelFetch();

    expect((await send(routerAiUrl, routerAiCall())).status).toBe(503);
    await expect(send(routerAiUrl, routerAiCall())).rejects.toThrow(
      "fetch failed"
    );
    expect(urls(sent)).toEqual(["routerai", "routerai"]);
    expect(warn).not.toHaveBeenCalledWith(
      "[model] fallback cloudru-fm on",
      expect.anything()
    );
  });

  it("carries a plugin, such as web search", async () => {
    const sent = network([failed(503, "Service Unavailable")]);

    const response = await (
      await modelFetch()
    )(routerAiUrl, routerAiCall({ plugins: ["web"] }));

    expect(response.status).toBe(503);
    expect(urls(sent)).toEqual(["routerai"]);
  });

  it("is no chat call", async () => {
    const sent = network([failed(503, "Service Unavailable")]);

    const response = await (
      await modelFetch()
    )("https://routerai.test/api/v1/credits", routerAiCall());

    expect(response.status).toBe(503);
    expect(urls(sent)).toEqual(["routerai"]);
  });
});

describe("after RouterAI's route failed", () => {
  it("sends chat calls straight to Foundation Models for five minutes, then tries RouterAI again", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-03T09:00:00Z"),
      toFake: ["Date"],
    });
    const sent = network(
      [connectTimeout(), streamed(openAiStream("Снова RouterAI"))],
      [streamed(openAiStream("Да")), streamed(openAiStream("Да"))]
    );
    const send = await modelFetch();

    await send(routerAiUrl, routerAiCall());
    vi.setSystemTime(new Date("2026-10-03T09:04:59Z"));
    await send(routerAiUrl, routerAiCall());
    vi.setSystemTime(new Date("2026-10-03T09:05:00Z"));
    const probe = await send(routerAiUrl, routerAiCall());

    expect(await probe.text()).toBe(openAiStream("Снова RouterAI"));
    expect(urls(sent)).toEqual([
      "routerai",
      "cloudru-fm",
      "cloudru-fm",
      "routerai",
    ]);
    // Foundation Models' failures or answers named no RouterAI host.
    expect(sent[3]?.body.provider).toEqual({
      ignore: ["deepseek"],
      order: ["deepinfra"],
    });
    expect(info).toHaveBeenCalledWith("[model] fallback cloudru-fm off", {
      reason: "RouterAI answered",
    });
  });

  it("keeps Foundation Models five more minutes when the probe fails", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-03T09:00:00Z"),
      toFake: ["Date"],
    });
    const sent = network(
      [
        connectTimeout(),
        failed(503, "Service Unavailable"),
        streamed(openAiStream("Снова RouterAI")),
      ],
      [
        streamed(openAiStream("Да")),
        streamed(openAiStream("Да")),
        streamed(openAiStream("Да")),
      ]
    );
    const send = await modelFetch();

    await send(routerAiUrl, routerAiCall());
    vi.setSystemTime(new Date("2026-10-03T09:05:00Z"));
    await send(routerAiUrl, routerAiCall());
    vi.setSystemTime(new Date("2026-10-03T09:09:59Z"));
    await send(routerAiUrl, routerAiCall());
    vi.setSystemTime(new Date("2026-10-03T09:10:00Z"));
    await send(routerAiUrl, routerAiCall());

    expect(urls(sent)).toEqual([
      "routerai",
      "cloudru-fm",
      "routerai",
      "cloudru-fm",
      "cloudru-fm",
      "routerai",
    ]);
    expect(warn).toHaveBeenCalledWith("[model] fallback cloudru-fm on", {
      probe: true,
      reason: "HTTP 503",
    });
  });

  it("sends one probe while the other calls stay on Foundation Models", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-03T09:00:00Z"),
      toFake: ["Date"],
    });
    const { promise: probeAnswer, resolve: answerProbe } =
      Promise.withResolvers<Response>();
    let routerAiCalls = 0;
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        sent.push(url === foundationModelsUrl ? "cloudru-fm" : "routerai");
        if (url === foundationModelsUrl) {
          return Promise.resolve(streamed(openAiStream("Да")));
        }
        routerAiCalls += 1;
        if (routerAiCalls === 1) throw connectTimeout();
        return probeAnswer;
      })
    );
    const send = await modelFetch();

    await send(routerAiUrl, routerAiCall());
    vi.setSystemTime(new Date("2026-10-03T09:05:00Z"));
    const probe = send(routerAiUrl, routerAiCall());
    await send(routerAiUrl, routerAiCall());
    answerProbe(streamed(openAiStream("Снова RouterAI")));
    await probe;

    expect(sent).toEqual(["routerai", "cloudru-fm", "routerai", "cloudru-fm"]);
  });
});

describe("a step Foundation Models answered", () => {
  it("reaches eve with its tokens and without a price", async () => {
    network([connectTimeout()], [streamed(openAiStream("Да"))]);
    const model = createOpenRouter({
      apiKey: "routerai-test-key",
      baseURL: "https://routerai.test/api/v1",
      fetch: await modelFetch(),
    }).chat("deepseek/deepseek-v4.1-flash");

    const { stream } = await model.doStream({
      prompt: [{ content: [{ text: "Привет", type: "text" }], role: "user" }],
    });
    const parts = await Array.fromAsync(stream);

    expect(
      parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
    ).toEqual(["Да"]);
    const finish = parts.find((part) => part.type === "finish");
    expect(finish?.usage.inputTokens.total).toBe(10);
    expect(finish?.usage.outputTokens.total).toBe(2);
    // No `usage.cost`: `stepCostMiddleware` leaves the step unpriced.
    expect(finish?.providerMetadata?.openrouter).not.toHaveProperty(
      "usage.cost"
    );
  });
});

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://bro.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  MODEL_PROVIDER: "routerai",
  ROUTERAI_API_KEY: "routerai-test-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

/** RouterAI's answer to the next model call, as its server sent it. */
function answer(body: string, init: { status?: number; stream?: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(body, {
          headers: {
            "content-type": init.stream
              ? "text/event-stream"
              : "application/json",
          },
          status: init.status ?? 200,
        })
      )
    )
  );
}

/** A model of the provider package on RouterAI's fetch, as Bro builds it. */
async function routerAiModel(order?: readonly string[]) {
  const { routerAiModelFetch } =
    await import("@agent/lib/model/routerai/fetch");
  return createOpenRouter({
    apiKey: "routerai-test-key",
    baseURL: "https://routerai.test/api/v1",
    fetch: routerAiModelFetch,
  }).chat(
    "deepseek/deepseek-v4.1-flash",
    order === undefined
      ? {}
      : { provider: { ignore: ["deepseek"], order: [...order] } }
  );
}

const call = {
  prompt: [
    {
      content: [{ text: "Привет", type: "text" as const }],
      role: "user" as const,
    },
  ],
};

async function generationError() {
  const model = await routerAiModel();
  try {
    await model.doGenerate(call);
  } catch (error) {
    return error;
  }
  throw new Error("The call succeeded.");
}

/** Every part of a streamed answer. */
async function streamedParts(order?: readonly string[]) {
  const model = await routerAiModel(order);
  const { stream } = await model.doStream(call);
  return Array.fromAsync(stream);
}

/** The parts of a streamed answer that report an error. */
function failures(parts: Awaited<ReturnType<typeof streamedParts>>) {
  return parts.flatMap((part) => (part.type === "error" ? [part.error] : []));
}

/** One event of a streamed answer with this delta, as RouterAI frames it. */
function chunk(delta: { readonly content: string; readonly role: string }) {
  return `data: ${JSON.stringify({ choices: [{ delta, index: 0 }], id: "rai-2" })}\r\n\r\n`;
}

/** RouterAI's text that holds an upstream's whole JSON answer. */
function upstreamError(code: number, message: string) {
  return JSON.stringify(
    JSON.stringify({ error: { code, message }, user_id: "user_1" })
  );
}

beforeEach(() => {
  vi.resetModules();
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("RouterAI's errors", () => {
  it("fails an HTTP 200 that holds an upstream error with the upstream's status", async () => {
    // RouterAI pads a slow answer with whitespace before the JSON.
    answer(
      `\n         \n{"error":${upstreamError(402, "Insufficient credits")}}`,
      {}
    );

    const error = await generationError();

    expect(APICallError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({
      message: "Insufficient credits",
      statusCode: 402,
    });
  });

  it("fails an HTTP 200 whose error names no status as a bad gateway", async () => {
    answer('{"error":"upstream closed the connection"}', {});

    expect(await generationError()).toMatchObject({
      isRetryable: true,
      message: "upstream closed the connection",
      statusCode: 502,
    });
  });

  it("reads RouterAI's own refusals in plain text with their status", async () => {
    answer('{"error":"401 Unauthorized"}', { status: 401 });
    expect(await generationError()).toMatchObject({
      message: "401 Unauthorized",
      statusCode: 401,
    });

    answer(`{"error":${upstreamError(400, "Provider returned 400")}}`, {
      status: 503,
    });
    expect(await generationError()).toMatchObject({
      message: "Provider returned 400",
      statusCode: 503,
    });

    answer("", { status: 503 });
    expect(await generationError()).toMatchObject({ statusCode: 503 });
  });

  it("passes a padded answer through as it came", async () => {
    answer(
      `\n   \n${JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: { content: "Привет", role: "assistant" },
          },
        ],
        id: "rai-1",
        usage: {
          completion_tokens: 2,
          cost: 0.0001,
          prompt_tokens: 10,
          total_tokens: 12,
        },
      })}`,
      {}
    );

    const model = await routerAiModel();
    const result = await model.doGenerate(call);

    expect(result.content).toEqual([{ text: "Привет", type: "text" }]);
    expect(result.providerMetadata?.openrouter).toMatchObject({
      usage: { cost: 0.0001 },
    });
  });

  it("turns a stream's error event into an error with the upstream's status", async () => {
    answer(
      [
        ": PROCESSING\n\n",
        `data: {"error":${upstreamError(429, "Provider returned error")}}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      { stream: true }
    );

    const parts = await streamedParts();

    // eve looks for `statusCode` on the error and its causes.
    expect(failures(parts)).toMatchObject([
      { code: 429, message: "Provider returned error", statusCode: 429 },
    ]);
  });

  it("takes a stream's error event that names no status for a bad gateway", async () => {
    answer(
      [
        'data: {"error":"upstream connection reset"}\n\n',
        "data: [DONE]\n\n",
      ].join(""),
      { stream: true }
    );

    const parts = await streamedParts();

    expect(failures(parts)).toMatchObject([
      { message: "upstream connection reset", statusCode: 502 },
    ]);
  });

  it("keeps a provider's failure mid-answer with its status", async () => {
    const failure = JSON.stringify({
      choices: [],
      error: {
        code: 502,
        message: "Provider returned error",
        metadata: { error_type: "upstream_error" },
      },
      id: "rai-2",
    });
    const body = `${chunk({ content: "Да", role: "assistant" })}data: ${failure}\r\n\r\ndata: [DONE]\r\n\r\n`;
    // Split mid-event, as the network may cut it.
    const encoder = new TextEncoder();
    const middle = body.indexOf('"Provider');
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(body.slice(0, middle)));
                controller.enqueue(encoder.encode(body.slice(middle)));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } }
          )
        )
      )
    );

    const parts = await streamedParts();

    expect(
      parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
    ).toEqual(["Да"]);
    expect(failures(parts)).toMatchObject([
      {
        code: 502,
        metadata: { error_type: "upstream_error" },
        statusCode: 502,
      },
    ]);
  });
});

/**
 * RouterAI's next answers, one per call, and the routing each call asked
 * for: a stream's text, or a whole answer as RouterAI sent it.
 */
function answers(...bodies: readonly (string | Response)[]) {
  const routing: unknown[] = [];
  const pending = [...bodies];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_input, init) => {
      const sent = z
        .object({ provider: z.unknown().optional() })
        .parse(JSON.parse(z.string().parse(init?.body)));
      routing.push(sent.provider);
      const body = pending.shift();
      if (body === undefined) throw new Error("No answer is left.");
      return Promise.resolve(
        body instanceof Response
          ? body
          : new Response(body, {
              headers: { "content-type": "text/event-stream" },
            })
      );
    })
  );
  return routing;
}

/** One event of a stream as RouterAI frames it. */
function event(json: string) {
  return `data: ${json}\n\n`;
}

/** A streamed answer of this text, served by this host. */
function served(provider: string, text: string) {
  return [
    ": PROCESSING\n\n",
    event(
      JSON.stringify({
        choices: [{ delta: { content: text, role: "assistant" }, index: 0 }],
        id: "rai-3",
        provider,
      })
    ),
    event(
      JSON.stringify({
        choices: [{ delta: { content: "" }, finish_reason: "stop", index: 0 }],
        id: "rai-3",
        provider,
        usage: {
          completion_tokens: 2,
          cost: 0.01,
          prompt_tokens: 10,
          total_tokens: 12,
        },
      })
    ),
    "data: [DONE]\n\n",
  ].join("");
}

/** An answer the host broke off at its end, after its text, as on 01.10. */
function brokenOff(provider: string, text: string) {
  return [
    event(
      JSON.stringify({
        choices: [{ delta: { content: text, role: "assistant" }, index: 0 }],
        id: "rai-4",
        provider,
      })
    ),
    event(
      JSON.stringify({
        choices: [{ delta: { content: "" }, finish_reason: "error", index: 0 }],
        id: "rai-4",
        provider,
        usage: {
          completion_tokens: 209,
          cost: null,
          prompt_tokens: 64_539,
          total_tokens: 64_748,
        },
      })
    ),
    "data: [DONE]\n\n",
  ].join("");
}

/** The upstream error RouterAI sends when a host fails mid-answer. */
function upstreamFailure(host: string) {
  return `data: ${JSON.stringify({
    error: {
      code: null,
      message: `Upstream error from ${host}: The model worker could not complete this request.`,
      metadata: { error_type: "provider_unavailable" },
    },
  })}\n\ndata: [DONE]\n\n`;
}

function texts(parts: Awaited<ReturnType<typeof streamedParts>>) {
  return parts.flatMap((part) =>
    part.type === "text-delta" ? [part.delta] : []
  );
}

describe("a pinned RouterAI host that fails an answer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is skipped, and the call goes out again before anything reaches eve", async () => {
    const routing = answers(
      brokenOff("Sail Research", "Напомню"),
      served("DeepInfra", "Готово")
    );

    const parts = await streamedParts(["sail-research", "deepinfra"]);

    // Nothing of the broken answer is passed on.
    expect(texts(parts)).toEqual(["Готово"]);
    expect(failures(parts)).toEqual([]);
    expect(routing).toEqual([
      { ignore: ["deepseek"], order: ["sail-research", "deepinfra"] },
      { ignore: ["deepseek", "sail-research"], order: ["deepinfra"] },
    ]);
  });

  it("stays skipped for ten minutes", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-01T22:40:00Z"),
      toFake: ["Date"],
    });
    const routing = answers(
      upstreamFailure("DeepInfra"),
      served("Novita", "Да"),
      served("Novita", "Да"),
      served("DeepInfra", "Да")
    );

    expect(texts(await streamedParts(["deepinfra"]))).toEqual(["Да"]);
    vi.setSystemTime(new Date("2026-10-01T22:49:59Z"));
    await streamedParts(["deepinfra"]);
    vi.setSystemTime(new Date("2026-10-01T22:50:00Z"));
    await streamedParts(["deepinfra"]);

    expect(routing).toEqual([
      { ignore: ["deepseek"], order: ["deepinfra"] },
      // No host is left pinned: RouterAI routes the call itself.
      { ignore: ["deepseek", "deepinfra"] },
      { ignore: ["deepseek", "deepinfra"] },
      { ignore: ["deepseek"], order: ["deepinfra"] },
    ]);
  });

  it("fails the call as an outage once three hosts in a row failed", async () => {
    const routing = answers(
      upstreamFailure("Sail Research"),
      brokenOff("DeepInfra", "Да"),
      brokenOff("StreamLake", "Да")
    );

    const parts = await streamedParts([
      "sail-research",
      "deepinfra",
      "streamlake",
    ]);

    expect(routing).toHaveLength(3);
    expect(texts(parts)).toEqual(["Да"]);
    // eve retries the step on a 5xx, and «скоро вернусь» knows it.
    expect(failures(parts)).toMatchObject([
      { message: "StreamLake broke off its answer.", statusCode: 502 },
    ]);
  });

  it("is skipped on a failure status with an error object", async () => {
    const routing = answers(
      new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: "Upstream error from DeepInfra: Rate limit exceeded",
          },
        }),
        { headers: { "content-type": "application/json" }, status: 429 }
      ),
      served("Novita", "Да")
    );

    const parts = await streamedParts(["deepinfra", "novita"]);

    expect(texts(parts)).toEqual(["Да"]);
    expect(routing).toEqual([
      { ignore: ["deepseek"], order: ["deepinfra", "novita"] },
      { ignore: ["deepseek", "deepinfra"], order: ["novita"] },
    ]);
  });

  it("is not skipped for a refusal another host would repeat", async () => {
    const routing = answers(
      `data: ${JSON.stringify({ error: { code: 402, message: "Upstream error from DeepInfra: Insufficient credits" } })}\n\ndata: [DONE]\n\n`
    );

    const parts = await streamedParts(["deepinfra"]);

    expect(routing).toHaveLength(1);
    expect(failures(parts)).toMatchObject([{ statusCode: 402 }]);
  });

  it("is not looked for among hosts the call did not pin", async () => {
    const routing = answers(brokenOff("Sail Research", "Да"));

    const parts = await streamedParts();

    expect(routing).toEqual([undefined]);
    expect(failures(parts)).toMatchObject([
      { message: "Sail Research broke off its answer.", statusCode: 502 },
    ]);
  });
});

describe("a call made once through RouterAI", () => {
  const body = (order: readonly string[]) =>
    JSON.stringify({ provider: { ignore: ["deepseek"], order } });
  const headers = { "content-type": "application/json" };

  it("returns a failed pinned host's failure without a second try, and skips the host from the next call", async () => {
    const routing = answers(
      new Response(
        JSON.stringify({
          error: {
            code: 503,
            message: "Upstream error from DeepInfra: no capacity",
          },
        }),
        { headers, status: 503 }
      ),
      new Response("{}", { headers })
    );
    const { routerAiFetchOnce } =
      await import("@agent/lib/model/routerai/fetch");
    const url = "https://routerai.test/api/v1/chat/completions";

    const failed = await routerAiFetchOnce(url, {
      body: body(["deepinfra"]),
      method: "POST",
    });
    expect(failed.status).toBe(503);
    expect(routing).toHaveLength(1);

    await routerAiFetchOnce(url, {
      body: body(["deepinfra"]),
      method: "POST",
    });
    expect(routing).toEqual([
      { ignore: ["deepseek"], order: ["deepinfra"] },
      { ignore: ["deepseek", "deepinfra"] },
    ]);
  });
});

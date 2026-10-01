import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  OPENROUTER_API_KEY: "openrouter-test-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

/** The request shape this client is expected to send to either backend. */
const requestBodySchema = z.object({
  max_tokens: z.number(),
  messages: z.array(z.object({ content: z.string(), role: z.string() })),
  model: z.string(),
  plugins: z.array(
    z.strictObject({
      engine: z.string(),
      id: z.string(),
      include_domains: z.array(z.string()).optional(),
      max_results: z.number(),
    })
  ),
  provider: z.strictObject({ ignore: z.array(z.string()) }).optional(),
  reasoning: z.object({ enabled: z.boolean() }),
  temperature: z.number(),
});

interface SearchRequest {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly signal: AbortSignal;
}

function completion(message: {
  readonly annotations?: readonly {
    readonly type: string;
    readonly url_citation?: {
      readonly content?: string;
      readonly title?: string;
      readonly url: string;
    };
  }[];
  readonly content?: string;
}) {
  return new Response(JSON.stringify({ choices: [{ message }] }));
}

function oneCitation() {
  return completion({
    annotations: [
      {
        type: "url_citation",
        url_citation: { title: "A", url: "https://a.example/one" },
      },
    ],
  });
}

function failure(status: number) {
  return new Response(JSON.stringify({ error: "upstream" }), { status });
}

function namedError(name: string) {
  return Object.assign(new Error(`${name} from fetch`), { name });
}

async function loadSearchWeb() {
  const search = await import("@agent/lib/web-search/search");
  return search.searchWeb;
}

const fetchMock =
  vi.fn<(url: string, init: SearchRequest) => Promise<Response>>();

function requestAt(index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error("The search did not reach the backend.");
  const [url, init] = call;
  return { body: requestBodySchema.parse(JSON.parse(init.body)), init, url };
}

function turnSignal() {
  return new AbortController().signal;
}

/** Runs the pause before the retry out and returns what the search threw. */
async function failureOf(pending: Promise<readonly object[]>) {
  const thrown = pending.then(
    () => "no failure",
    (cause: unknown) => String(cause)
  );
  await vi.runAllTimersAsync();
  return await thrown;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  fetchMock.mockReset();
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenRouter web search", () => {
  it("searches through Exa and reads only the citations", async () => {
    fetchMock.mockResolvedValue(oneCitation());

    const searchWeb = await loadSearchWeb();
    await searchWeb({ query: "курс рубля" }, turnSignal());

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = requestAt(0);
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toEqual({
      authorization: "Bearer openrouter-test-key",
      "content-type": "application/json",
      "HTTP-Referer": "https://openinstinct.example",
      "X-Title": "Bro",
    });
    expect(request.body.model).toBe("deepseek/deepseek-v4.1-flash");
    // OpenRouter keeps its own routing.
    expect(request.body.provider).toBeUndefined();
    // Left unset, OpenRouter picks the model's native search, slow on OpenAI.
    expect(request.body.plugins).toEqual([
      { engine: "exa", id: "web", max_results: 8 },
    ]);
    // Nothing the model writes is read, so it writes next to nothing.
    expect(request.body.max_tokens).toBe(16);
    expect(request.body.reasoning).toEqual({ enabled: false });
    expect(request.body.temperature).toBe(0);
    expect(request.body.messages.at(-1)).toEqual({
      content: "курс рубля",
      role: "user",
    });
  });

  it("limits the search to the sites the model named", async () => {
    fetchMock.mockResolvedValue(oneCitation());

    const searchWeb = await loadSearchWeb();
    await searchWeb(
      {
        query: "Авокадо Чистопрудный бульвар",
        sites: ["https://www.2gis.ru/", " Yandex.ru/maps ", "2gis.ru"],
      },
      turnSignal()
    );

    expect(requestAt(0).body.plugins).toEqual([
      {
        engine: "exa",
        id: "web",
        include_domains: ["2gis.ru", "yandex.ru/maps"],
        max_results: 8,
      },
    ]);
  });

  it("uses the configured search model instead of the inference default", async () => {
    vi.stubEnv("OPENROUTER_MODEL", "anthropic/claude-sonnet-4.5");
    vi.stubEnv("OPENROUTER_SEARCH_MODEL", " openai/gpt-5.6-sol-fast ");
    fetchMock.mockResolvedValue(oneCitation());

    const searchWeb = await loadSearchWeb();
    await searchWeb({ query: "anything" }, turnSignal());

    expect(requestAt(0).body.model).toBe("openai/gpt-5.6-sol-fast");
  });

  it("reads results and their excerpts from url_citation annotations", async () => {
    fetchMock.mockResolvedValue(
      completion({
        annotations: [
          {
            type: "url_citation",
            url_citation: {
              content:
                "# Кафе Авокадо\n\n...\n\n![фото](https://img.example/1.jpg)[\u200BЧистопрудный бул., 12](https://maps.example/house/12) · Чистые пруды 7 мин. пешком\n\n[...]\n\nСредний чек ~1200₽\n\n...",
              title: " Кафе Авокадо ",
              url: "https://restoran.example/avokado",
            },
          },
          { type: "file_citation" },
          {
            type: "url_citation",
            url_citation: { url: "https://restoran.example/avokado" },
          },
          {
            type: "url_citation",
            url_citation: { title: "Bad", url: "not-a-url" },
          },
          {
            type: "url_citation",
            url_citation: { title: "Second", url: "https://news.example/two" },
          },
        ],
        content: "OK",
      })
    );

    const searchWeb = await loadSearchWeb();

    expect(await searchWeb({ query: "авокадо" }, turnSignal())).toEqual([
      {
        snippet:
          "Кафе Авокадо … Чистопрудный бул., 12 · Чистые пруды 7 мин. пешком … Средний чек ~1200₽",
        title: "Кафе Авокадо",
        url: "https://restoran.example/avokado",
      },
      { snippet: "", title: "Second", url: "https://news.example/two" },
    ]);
  });

  it("reads an answer that carries `error: null` as a success", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: { title: "A", url: "https://a.example/one" },
                  },
                ],
              },
            },
          ],
          error: null,
        })
      )
    );

    const searchWeb = await loadSearchWeb();

    expect(await searchWeb({ query: "кафе" }, turnSignal())).toEqual([
      { snippet: "", title: "A", url: "https://a.example/one" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps up to 500 characters of each excerpt and at most eight results", async () => {
    fetchMock.mockResolvedValue(
      completion({
        annotations: Array.from({ length: 12 }, (_value, index) => ({
          type: "url_citation",
          url_citation: {
            content: "слово ".repeat(200),
            title: `Result ${String(index)}`,
            url: `https://example.com/${String(index)}`,
          },
        })),
      })
    );

    const searchWeb = await loadSearchWeb();
    const results = await searchWeb({ query: "rates" }, turnSignal());

    expect(results).toHaveLength(8);
    expect(results[0]?.snippet).toHaveLength(500);
  });

  it("hands a throttled search to Perplexity after a short pause", async () => {
    fetchMock
      .mockResolvedValueOnce(failure(429))
      .mockResolvedValueOnce(oneCitation());

    const searchWeb = await loadSearchWeb();
    const pending = searchWeb({ query: "rates" }, turnSignal());
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestAt(1).body.plugins).toEqual([
      { engine: "perplexity", id: "web", max_results: 8 },
    ]);
  });

  it("gives each attempt its own time limit and retries one that ran out", async () => {
    fetchMock
      .mockRejectedValueOnce(namedError("TimeoutError"))
      .mockResolvedValueOnce(oneCitation());

    const searchWeb = await loadSearchWeb();
    const pending = searchWeb({ query: "rates" }, turnSignal());
    await vi.runAllTimersAsync();

    expect(await pending).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map(([, init]) => init);
    expect(first?.signal).not.toBe(second?.signal);
  });

  it("retries when OpenRouter could not be reached", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(oneCitation());

    const searchWeb = await loadSearchWeb();
    const pending = searchWeb({ query: "rates" }, turnSignal());
    await vi.runAllTimersAsync();

    expect(await pending).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks the other engine when the first found nothing", async () => {
    fetchMock
      .mockResolvedValueOnce(completion({ content: "OK" }))
      .mockResolvedValueOnce(oneCitation());

    const searchWeb = await loadSearchWeb();
    const pending = searchWeb({ query: "rates" }, turnSignal());
    await vi.runAllTimersAsync();

    expect(await pending).toHaveLength(1);
    expect(requestAt(1).body.plugins[0]?.engine).toBe("perplexity");
  });

  it("reports the failure that survives the retry", async () => {
    fetchMock.mockImplementation(async () => failure(503));

    const searchWeb = await loadSearchWeb();
    expect(
      await failureOf(searchWeb({ query: "rates" }, turnSignal()))
    ).toContain("OpenRouter 503");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports nothing found after both engines came back empty", async () => {
    fetchMock.mockImplementation(async () => completion({ content: "OK" }));

    const searchWeb = await loadSearchWeb();
    expect(
      await failureOf(searchWeb({ query: "rates" }, turnSignal()))
    ).toContain("nothing was found");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejected request", async () => {
    fetchMock.mockResolvedValue(failure(402));

    const searchWeb = await loadSearchWeb();

    await expect(searchWeb({ query: "rates" }, turnSignal())).rejects.toThrow(
      "OpenRouter 402"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry once the turn itself was aborted", async () => {
    const turn = new AbortController();
    fetchMock.mockImplementation(async () => {
      turn.abort();
      throw namedError("AbortError");
    });

    const searchWeb = await loadSearchWeb();

    await expect(searchWeb({ query: "rates" }, turn.signal)).rejects.toThrow(
      "AbortError from fetch"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a body that is not an OpenRouter completion", async () => {
    fetchMock.mockImplementation(
      async () => new Response("<html>gateway</html>")
    );

    const searchWeb = await loadSearchWeb();
    expect(
      await failureOf(searchWeb({ query: "rates" }, turnSignal()))
    ).toContain("unusable body");
  });

  it("refuses to search without a direct backend", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const searchWeb = await loadSearchWeb();

    await expect(searchWeb({ query: "rates" }, turnSignal())).rejects.toThrow(
      "Web search needs a direct model backend"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** RouterAI's failure under HTTP 200: the upstream's answer as text. */
function routerAiFailure(code: number) {
  return new Response(
    `\n   \n${JSON.stringify({
      error: JSON.stringify({ error: { code, message: "upstream said no" } }),
    })}`
  );
}

describe("RouterAI web search", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("MODEL_PROVIDER", "routerai");
    vi.stubEnv("ROUTERAI_API_KEY", "routerai-test-key");
  });

  it("searches through RouterAI with its key and no attribution headers", async () => {
    fetchMock.mockResolvedValue(oneCitation());

    const searchWeb = await loadSearchWeb();
    await searchWeb({ query: "курс доллара ЦБ" }, turnSignal());

    const request = requestAt(0);
    expect(request.url).toBe("https://routerai.ru/api/v1/chat/completions");
    expect(request.init.headers).toEqual({
      authorization: "Bearer routerai-test-key",
      "content-type": "application/json",
    });
    // Exa is billed by the page, so RouterAI asks for fewer.
    expect(request.body.plugins).toEqual([
      { engine: "exa", id: "web", max_results: 5 },
    ]);
    expect(request.body.reasoning).toEqual({ enabled: false });
  });

  it("skips RouterAI's own DeepSeek endpoint and the hosts the deployment skips", async () => {
    vi.stubEnv("ROUTERAI_PROVIDER_IGNORE", "io-net, DeepSeek");
    vi.stubEnv("ROUTERAI_SEARCH_MAX_RESULTS", "3");
    fetchMock.mockResolvedValue(oneCitation());

    const searchWeb = await loadSearchWeb();
    await searchWeb({ query: "anything" }, turnSignal());

    const { body } = requestAt(0);
    expect(body.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(body.provider).toEqual({ ignore: ["deepseek", "io-net"] });
    expect(body.plugins[0]?.max_results).toBe(3);
  });

  it("leaves another reading model to RouterAI's routing", async () => {
    vi.stubEnv("ROUTERAI_SEARCH_MODEL", "openai/gpt-6-luna");
    fetchMock.mockResolvedValue(oneCitation());

    const searchWeb = await loadSearchWeb();
    await searchWeb({ query: "anything" }, turnSignal());

    expect(requestAt(0).body.model).toBe("openai/gpt-6-luna");
    expect(requestAt(0).body.provider).toBeUndefined();
  });

  it("reads a throttle RouterAI reports under HTTP 200 and asks the other engine", async () => {
    fetchMock
      .mockResolvedValueOnce(routerAiFailure(429))
      .mockResolvedValueOnce(oneCitation());

    const searchWeb = await loadSearchWeb();
    const pending = searchWeb({ query: "rates" }, turnSignal());
    await vi.runAllTimersAsync();

    expect(await pending).toHaveLength(1);
    expect(requestAt(1).body.plugins[0]?.engine).toBe("perplexity");
  });

  it("does not retry a refusal RouterAI reports under HTTP 200", async () => {
    fetchMock.mockResolvedValue(routerAiFailure(402));

    const searchWeb = await loadSearchWeb();

    await expect(searchWeb({ query: "rates" }, turnSignal())).rejects.toThrow(
      "RouterAI 402: upstream said no"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the status of a refusal written as plain text", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "401 Unauthorized" }), {
        status: 401,
      })
    );

    const searchWeb = await loadSearchWeb();

    await expect(searchWeb({ query: "rates" }, turnSignal())).rejects.toThrow(
      "RouterAI 401"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries an error that names no status", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ error: "upstream went away" }))
    );

    const searchWeb = await loadSearchWeb();
    expect(
      await failureOf(searchWeb({ query: "rates" }, turnSignal()))
    ).toContain("RouterAI error: upstream went away");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

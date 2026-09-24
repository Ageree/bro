import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  OPENROUTER_API_KEY: "openrouter-test-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

/** The OpenRouter request shape this client is expected to send. */
const requestBodySchema = z.object({
  max_tokens: z.number(),
  messages: z.array(z.object({ content: z.string(), role: z.string() })),
  model: z.string(),
  plugins: z.array(z.object({ id: z.string(), max_results: z.number() })),
  reasoning: z.object({ enabled: z.boolean() }),
  temperature: z.number(),
});

interface SearchRequest {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly method: string;
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

async function loadSearchWeb() {
  const openrouter = await import("@agent/lib/web-search/openrouter");
  return openrouter.searchWeb;
}

const fetchMock =
  vi.fn<(url: string, init: SearchRequest) => Promise<Response>>();

function requestAt(index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error("The search did not reach OpenRouter.");
  const [url, init] = call;
  return { body: requestBodySchema.parse(JSON.parse(init.body)), init, url };
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenRouter web search", () => {
  it("asks the chat completions endpoint for the web plugin", async () => {
    fetchMock.mockResolvedValue(oneCitation());

    const searchWeb = await loadSearchWeb();
    await searchWeb({ query: "курс рубля", recency: "week" });

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
    expect(request.body.model).toBe("openai/gpt-6-luna");
    expect(request.body.max_tokens).toBe(700);
    expect(request.body.plugins).toEqual([{ id: "web", max_results: 8 }]);
    expect(request.body.reasoning).toEqual({ enabled: false });
    expect(request.body.temperature).toBe(0);
    expect(request.body.messages).toHaveLength(2);
    expect(request.body.messages.at(0)?.role).toBe("system");
    expect(request.body.messages.at(0)?.content).toContain("last week");
    expect(request.body.messages.at(1)).toEqual({
      content: "курс рубля",
      role: "user",
    });
  });

  it("omits the recency hint when the model did not ask for one", async () => {
    fetchMock.mockResolvedValue(oneCitation());

    const searchWeb = await loadSearchWeb();
    await searchWeb({ query: "anything" });

    expect(requestAt(0).body.messages.at(0)?.content).not.toContain(
      "Prefer pages published"
    );
  });

  it("uses the configured search model instead of the inference default", async () => {
    vi.stubEnv("OPENROUTER_MODEL", "anthropic/claude-sonnet-4.5");
    vi.stubEnv("OPENROUTER_SEARCH_MODEL", " openai/gpt-5.6-sol-fast ");
    fetchMock.mockResolvedValue(oneCitation());

    const searchWeb = await loadSearchWeb();
    await searchWeb({ query: "anything" });

    expect(requestAt(0).body.model).toBe("openai/gpt-5.6-sol-fast");
  });

  it("reads results from url_citation annotations", async () => {
    fetchMock.mockResolvedValue(
      completion({
        annotations: [
          {
            type: "url_citation",
            url_citation: {
              content: "Rates  moved\nsharply today.",
              title: " Central bank ",
              url: "https://bank.example/rates",
            },
          },
          { type: "file_citation" },
          {
            type: "url_citation",
            url_citation: { url: "https://bank.example/rates" },
          },
          {
            type: "url_citation",
            url_citation: { title: "Second", url: "https://news.example/two" },
          },
        ],
        content: '[{"title":"Ignored","url":"https://ignored.example"}]',
      })
    );

    const searchWeb = await loadSearchWeb();

    expect(await searchWeb({ query: "rates" })).toEqual([
      {
        snippet: "Rates moved sharply today.",
        title: "Central bank",
        url: "https://bank.example/rates",
      },
      { snippet: "", title: "Second", url: "https://news.example/two" },
    ]);
  });

  it("falls back to the JSON array the model wrote", async () => {
    fetchMock.mockResolvedValue(
      completion({
        content: [
          "Here you go:",
          "```json",
          '[{"title":"One","url":"https://one.example","snippet":"First"},',
          ' {"title":"Bad","url":"not-a-url","snippet":"Dropped"}]',
          "```",
        ].join("\n"),
      })
    );

    const searchWeb = await loadSearchWeb();

    expect(await searchWeb({ query: "rates" })).toEqual([
      { snippet: "First", title: "One", url: "https://one.example" },
    ]);
  });

  it("returns at most eight results", async () => {
    fetchMock.mockResolvedValue(
      completion({
        annotations: Array.from({ length: 12 }, (_value, index) => ({
          type: "url_citation",
          url_citation: {
            title: `Result ${String(index)}`,
            url: `https://example.com/${String(index)}`,
          },
        })),
      })
    );

    const searchWeb = await loadSearchWeb();

    expect(await searchWeb({ query: "rates" })).toHaveLength(8);
  });

  it("retries once on a throttled reply", async () => {
    fetchMock
      .mockResolvedValueOnce(failure(429))
      .mockResolvedValueOnce(oneCitation());

    const searchWeb = await loadSearchWeb();

    expect(await searchWeb({ query: "rates" })).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a server failure that survives the retry", async () => {
    fetchMock.mockResolvedValue(failure(503));

    const searchWeb = await loadSearchWeb();

    await expect(searchWeb({ query: "rates" })).rejects.toThrow(
      "OpenRouter 503"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejected request", async () => {
    fetchMock.mockResolvedValue(failure(400));

    const searchWeb = await loadSearchWeb();

    await expect(searchWeb({ query: "rates" })).rejects.toThrow(
      "OpenRouter 400"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a reply that carries neither citations nor a JSON array", async () => {
    fetchMock.mockResolvedValue(
      completion({ content: "I could not find anything." })
    );

    const searchWeb = await loadSearchWeb();

    await expect(searchWeb({ query: "rates" })).rejects.toThrow("no results");
  });

  it("rejects a body that is not an OpenRouter completion", async () => {
    fetchMock.mockResolvedValue(new Response("<html>gateway</html>"));

    const searchWeb = await loadSearchWeb();

    await expect(searchWeb({ query: "rates" })).rejects.toThrow(
      "unusable body"
    );
  });

  it("refuses to search without a key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const searchWeb = await loadSearchWeb();

    await expect(searchWeb({ query: "rates" })).rejects.toThrow(
      "OPENROUTER_API_KEY is not configured."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

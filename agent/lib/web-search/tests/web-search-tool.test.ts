import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

const fetchMock = vi.fn<() => Promise<Response>>();

async function loadTool() {
  return await import("@agent/tools/web_search");
}

function toolContext() {
  return {
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getToken: vi.fn<ToolContext["getToken"]>(),
    requireAuth: vi.fn<ToolContext["requireAuth"]>(),
    session: {
      auth: { current: null, initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "web_search",
  } satisfies ToolContext;
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

describe("web_search tool selection", () => {
  it("keeps eve's provider-managed search when OpenRouter is inactive", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const tool = await loadTool();
    const eve = await import("eve/tools/web_search");

    expect(tool.default).toBe(eve.defaultWebSearch);
    expect(tool.default).toMatchObject({
      kind: "eve:web-search-tool",
      provider: "exa",
    });
  });

  it("replaces it with an ordinary function tool when OpenRouter is active", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");

    const tool = await loadTool();

    // Resolved per turn, so Bro's own mail checks can go without it
    // (`tests/agent/capabilities.test.ts` covers which modes get it).
    expect(tool.default).toMatchObject({ kind: "eve:dynamic" });
    expect(tool.openRouterWebSearch.execute).toBeTypeOf("function");
  });

  it("lists the results it found", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      content: "The key rate stayed at 16 percent.",
                      title: "Rate decision",
                      url: "https://bank.example/rates",
                    },
                  },
                  {
                    type: "url_citation",
                    url_citation: {
                      title: "Coverage",
                      url: "https://news.example/two",
                    },
                  },
                ],
              },
            },
          ],
        })
      )
    );

    const { openRouterWebSearch } = await loadTool();

    expect(
      await openRouterWebSearch.execute({ query: "ставка" }, toolContext())
    ).toBe(
      [
        "1. Rate decision",
        "https://bank.example/rates",
        "The key rate stayed at 16 percent.",
        "",
        "2. Coverage",
        "https://news.example/two",
      ].join("\n")
    );
  });

  it("surfaces a failed search as tool result text", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "upstream" }), { status: 503 })
    );

    const { openRouterWebSearch } = await loadTool();
    const pending = openRouterWebSearch.execute(
      { query: "ставка" },
      toolContext()
    );
    await vi.runAllTimersAsync();

    const text = await pending;
    expect(text).toContain("search failed: OpenRouter 503");
    // Both engines were already asked; the model should not hammer them.
    expect(text).toContain("Do not repeat this query as is");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("names a timeout instead of leaking the abort error", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);

    const { openRouterWebSearch } = await loadTool();
    const pending = openRouterWebSearch.execute(
      { query: "ставка", sites: ["2gis.ru"] },
      toolContext()
    );
    await vi.runAllTimersAsync();

    const text = await pending;
    expect(text).toMatch(/^search failed: the search timed out\. /u);
    expect(text).toContain("or drop sites");
  });
});

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

  it("sends a search for tickets on given dates to a browser run", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("BROWSER_USE_API_KEY", "browser-use-test-key");
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  annotations: [
                    {
                      type: "url_citation",
                      url_citation: {
                        content: "На этом направлении курсирует 13 поездов.",
                        title: "Расписание поездов: Москва — Казань",
                        url: "https://www.tutu.ru/poezda/Moskva/Kazan/",
                      },
                    },
                  ],
                },
              },
            ],
          })
        )
    );
    const search = async (query: string, sites?: string[]) => {
      const { openRouterWebSearch } = await loadTool();
      return await openRouterWebSearch.execute({ query, sites }, toolContext());
    };

    // RU 25.09, d13: «найди мне поезд до казани на следующие выходные».
    const trains = await search(
      "поезд Москва Казань расписание билеты следующие выходные 2 октября 2026 4 октября 2026",
      ["rzd.ru", "tutu.ru"]
    );
    expect(trains).toMatch(/^1\. Расписание поездов: Москва — Казань\n/u);
    expect(trains).toContain(
      "start browser_task now without allowSubmit on the seller's site"
    );
    expect(trains).toContain("«в поезде только нижняя полка»");
    expect(
      await search("поезд Москва Казань 3 октября нижняя полка наличие мест")
    ).toContain("start browser_task now");
    expect(await search("hotel in Kazan for the weekend")).toContain(
      "start browser_task now"
    );

    // A dinner, a timetable in general and a flight's status are not it.
    for (const query of [
      "Казань ресторан ужин суббота центр средний чек меню ресторан 2026",
      "сколько идёт поезд из Москвы в Казань",
      "рейс SU 1234 статус сегодня",
      "training schedule tomorrow",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One query at a time keeps the failure readable.
      expect(await search(query)).not.toContain("browser_task");
    }

    // Without browser runs there is nothing to send it to. The environment
    // is read once, when its module loads.
    vi.stubEnv("BROWSER_USE_API_KEY", undefined);
    vi.resetModules();
    expect(
      await search("поезд Москва Казань 3 октября нижняя полка")
    ).not.toContain("browser_task");
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

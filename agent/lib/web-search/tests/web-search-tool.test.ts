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
    for (const query of [
      "hotel in Kazan for the weekend",
      "отель Казань 3-5 октября",
      "купе Москва Питер пятница",
      "отель рядом с Красной площадью 3 октября",
      "авиабилеты Москва Сочи 12.10",
      // A train or a flight outweighs the dinner asked for with it (d13).
      "найди мне поезд до казани на следующие выходные и где там поужинать в субботу",
      "поезд Москва Питер 3 октября вагон-ресторан",
      // A stay's own dinner, rating or landmark is still a stay.
      "отель в Сочи с завтраком и ужином на 3–10 октября",
      "отель в Казани 3–5 октября рейтинг от 8",
      "отель рядом с Большим театром 3-5 октября",
      "отель у метро Театральная 3 октября",
      // Days and berths said as adjectives.
      "билеты на завтрашний рейс Москва Сочи",
      "поезд Москва Казань сегодняшний вечер",
      "купейный вагон Москва Казань 3 октября",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One query at a time keeps the failure readable.
      expect(await search(query)).toContain("start browser_task now");
    }
    // A search held to a seller of tickets or rooms is one whatever else it
    // says.
    expect(
      await search(
        "поезд до Казани на следующие выходные и где поужинать в субботу",
        ["rzd.ru", "tutu.ru"]
      )
    ).toContain("start browser_task now");
    expect(
      await search("отель Сочи полупансион ужин 3-10 октября", ["ostrovok.ru"])
    ).toContain("start browser_task now");

    // A dinner, a timetable in general and a flight's status are not it,
    // and neither is a pick of a place or a master with a hotel as a
    // landmark or a day as when (review of 25.09).
    for (const query of [
      "Казань ресторан ужин суббота центр средний чек меню ресторан 2026",
      "сколько идёт поезд из Москвы в Казань",
      "поездка в Казань на выходные что посмотреть",
      "рейс SU 1234 статус сегодня",
      "training schedule tomorrow",
      "где поужинать рядом с отелем Метрополь в субботу",
      "ресторан ужин Казань суббота рядом с отелем",
      "кафе рядом с отелем Radisson завтрак сегодня",
      "интересные места рядом с отелем Азимут Москва",
      "ресторан рядом с гостиницей Космос в пятницу",
      "бар возле отеля Four Seasons на выходных",
      "сборка шкафа-купе Москва мастер завтра",
      "книжные полки наличие в магазине",
      "отели Казани с рейтингом 4.5 и выше",
      "restaurants near the hotel Metropol on Saturday",
      "шкаф купе сборка завтра",
      "билеты в театр на субботу",
      "отель с завтраком",
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

  /**
   * RU d03 (25.09): «все с вегетарианским меню и чеком до 2500» over an
   * option whose menu and bill were never checked, and restoran.cafe's «Мы
   * не бронируем столики» retold as «Авокадо не бронирует». RU d13: the
   * saved «свинину не ем» shaped no dinner pick.
   */
  it("reminds a pick of places how its facts go together, and whose «мы не бронируем» it is", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
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
                        content:
                          "Кафе Авокадо … Мы не бронируем столики в этом заведении :( … Чистопрудный бул., д. 12, к. 2",
                        title: "Кафе Авокадо на Чистых Прудах — Restoran.Cafe",
                        url: "https://restoran.cafe/moskva/restaurants/avokado-na-chistykh-prudakh",
                      },
                    },
                    {
                      type: "url_citation",
                      url_citation: {
                        content: "Вегетарианское кафе. Бронь столов.",
                        title: "Авокадо",
                        url: "https://avocadocafe.ru/",
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
    const search = (query: string) =>
      openRouterWebSearch.execute({ query }, toolContext());

    const pick = await search(
      "где поужинать Чистые пруды ресторан вегетарианское меню"
    );
    expect(pick).toContain(
      "Мы не бронируем столики в этом заведении :( … Чистопрудный бул., д. 12, к. 2\n(this site says it does not take the booking itself; it says nothing about whether the place does"
    );
    // Only the aggregator's own words get the note.
    expect(pick).toContain(
      "Вегетарианское кафе. Бронь столов.\n\nNote for a pick of places"
    );
    expect(pick).toContain(
      "give each option only facts that a result about that very option shows"
    );
    expect(pick).toContain(
      "write «все …» about the options only when every one of them has it confirmed"
    );
    expect(pick).toContain("replaced by searching on, not kept with a caveat");
    expect(pick).toContain("(«учёл: без свинины»)");

    // A search that picks nothing gets no such note.
    expect(await search("ключевая ставка ЦБ сегодня")).not.toContain(
      "Note for a pick"
    );
  });

  /**
   * RU d03 (26.09): «Авокадо» named first with «несколько кафе под одной
   * маркой» as its minus under «не сетевое», while restoran.cafe said «сеть
   * вегетарианских кафе» and 2GIS cards «6 филиалов»; two of three options
   * went out with «чек нигде не подтвердил». EN D3: «Джаганнат» passed as no
   * chain beside 2GIS's «3 филиала», and two options where the results held a
   * third.
   */
  it("marks a chain by its branches and holds a pick to three checked options with sources", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    const results = [
      {
        content:
          "Средний чек ~1200₽ … Авокадо – сеть вегетарианских кафе в Москве. Одно из заведений находится на Чистопрудном бульваре.",
        title: "Кафе Авокадо на Чистых Прудах — Restoran.Cafe",
        url: "https://restoran.cafe/moskva/restaurants/avokado-na-chistykh-prudakh",
      },
      {
        content: "Kulёk, кафе … Улица Покровка 1/6 ст2, 1 этаж 6 филиалов",
        title: "Kulёk, кафе — 2ГИС",
        url: "https://2gis.ru/moscow/firm/70000001089355304",
      },
      {
        content: "Джаганнат, вегетарианское кафе. 3 филиала. Чек 1500 ₽",
        title: "Джаганнат — 2ГИС",
        url: "https://2gis.ru/moscow/firm/1",
      },
      {
        content:
          "Рецептор — несетевое кафе во дворе библиотеки, 1 филиал. Не сетевое заведение.",
        title: "Рецептор",
        url: "https://a-a-ah.ru/receptor-chistoprudny",
      },
      {
        content: "Jagannath is a vegetarian restaurant chain with 4 locations.",
        title: "Jagannath",
        url: "https://example.com/jagannath",
      },
    ];
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  annotations: results.map((result) => ({
                    type: "url_citation",
                    url_citation: result,
                  })),
                },
              },
            ],
          })
        )
    );
    const { openRouterWebSearch } = await loadTool();

    const pick = await openRouterWebSearch.execute(
      { query: "ресторан Чистые пруды вегетарианское меню не сеть" },
      toolContext()
    );
    expect(pick).toContain(
      "Одно из заведений находится на Чистопрудном бульваре.\n(this result says «сеть вегетарианских кафе»: the place it is about has more than one branch under its name — a chain, so it does not pass «не сеть» when the person asked for that)"
    );
    expect(pick).toContain("1 этаж 6 филиалов\n(this result says «6 филиалов»");
    expect(pick).toContain(
      "3 филиала. Чек 1500 ₽\n(this result says «3 филиала»"
    );
    // One branch, or «несетевое», is no chain.
    expect(pick).toContain("Не сетевое заведение.\n\n5. Jagannath");
    expect(pick).toContain("(this result says «restaurant chain»");

    expect(pick).toContain(
      "«Не сеть» is checked by the number of branches: a map card with «2 филиала» or more, «сеть …», several addresses under one name, or «N locations» is a chain, and a chain is dropped, not named first with a minus."
    );
    expect(pick).toContain(
      "search by its name now — «<название> средний чек часы работы» with sites yandex.ru/maps or 2gis.ru — rather than reply with «не проверил»"
    );
    expect(pick).toContain(
      "Aim at three options that pass every condition: while the results name more candidates, check the next one instead of replying with two"
    );
    expect(pick).toContain(
      "Write «цены подтверждены» or «всё проверено» only when each option's own result shows it, and give that result's link."
    );
    expect(pick).toContain(
      "A conclusion that nothing fits (nothing within the budget, nothing open) only after two or three different sources, naming any that did not open and why."
    );
    expect(pick).toContain(
      "Saved preferences in memory are conditions only where they bear on this pick («Saved preferences for this request» names them)"
    );

    // A narrow search for one place's bill is part of the pick too.
    expect(
      await openRouterWebSearch.execute(
        { query: "Kiosk 1936 средний чек", sites: ["yandex.ru/maps"] },
        toolContext()
      )
    ).toContain("Note for a pick of places");
  });

  /**
   * RU d01 (26.09): ticket.rzd.ru did not open, and the fee on tutu.ru went
   * unsaid; RU d02 and EN D1 drew «nothing fits» from one site. RU d01 on
   * prod: «нижняя полка» and «у прохода» went with a «Сапсан» window seat.
   */
  it("asks a ticket search for fallback sellers, what failed and every fee", async () => {
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
                        content: "Расписание «Сапсанов» и цены от 1 916 ₽.",
                        title: "Сапсан Москва — Санкт-Петербург",
                        url: "https://www.tutu.ru/poezda/sapsan/",
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

    const note = await openRouterWebSearch.execute(
      { query: "сапсан Москва Петербург 2 октября места у окна" },
      toolContext()
    );
    expect(note).toContain(
      "never one the person's own words override (a seat they name wins over a saved one) and no berth for a seated train such as «Сапсан» or «Ласточка»"
    );
    expect(note).toContain(
      "Name two fallback sellers in the task in order («если на ticket.rzd.ru не выходит — tutu.ru, потом …»)"
    );
    expect(note).toContain(
      "ask the run to return which sites it checked, which did not open and why, and every fee on top of the fare (a seller's service or agent fee) apart from it: «nothing in the budget» or «no seats» holds only after two or three sites."
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
    expect(text).toContain(
      "A source that stays unread is named in the reply as not checked, with why — not left out, and not the ground for «nothing fits»."
    );
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

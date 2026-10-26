import type * as ai from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as siteOperationsService from "@db/services/browser-site-operations";
import type * as browserVmRuns from "@agent/lib/browser-vm/runs";
import type { BrowserVmSiteRead } from "@agent/lib/browser-vm/worker";
import { knownSiteOperations } from "@agent/lib/browser-vm/site-ops/known";
import { clearBrowserVmSettings } from "../../helpers/browser-vm";

/** What the fill's model answers (`fillSiteRead`). */
interface Filled {
  output: {
    limit: number | null;
    more?: boolean | null;
    operation: string | null;
    priceMax: number | null;
    priceMin: number | null;
    sort: "price_asc" | "price_desc" | "site" | null;
    url: string | null;
  };
}
/** What the first look's model answers (`guessSiteRead`). */
interface Guessed {
  output: { query: string | null; url: string | null };
}
/** What the model answers whether an errand asks about its links' own pages (`askedAboutPages`). */
interface AboutPages {
  output: { pages: boolean | null };
}
const model = vi.hoisted(() => ({
  generateText:
    vi.fn<
      (input: { prompt: string }) => Promise<Filled | Guessed | AboutPages>
    >(),
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof ai>()),
  generateText: model.generateText,
}));
const browser = vi.hoisted(() => ({
  lookBrowserVmSiteDirectly:
    vi.fn<typeof browserVmRuns.lookBrowserVmSiteDirectly>(),
  readBrowserVmItemDirectly:
    vi.fn<typeof browserVmRuns.readBrowserVmItemDirectly>(),
  readBrowserVmSiteDirectly:
    vi.fn<typeof browserVmRuns.readBrowserVmSiteDirectly>(),
}));
vi.mock("@agent/lib/browser-vm/runs", () => browser);
const records = vi.hoisted(() => ({
  deleteBrowserSiteOperation:
    vi.fn<typeof siteOperationsService.deleteBrowserSiteOperation>(),
  dropBrokenBrowserSiteOperations:
    vi.fn<typeof siteOperationsService.dropBrokenBrowserSiteOperations>(),
  listBrowserSiteOperations: vi.fn<
    typeof siteOperationsService.listBrowserSiteOperations
  >(() => Promise.resolve([])),
  noteBrowserSiteOperationRead:
    vi.fn<typeof siteOperationsService.noteBrowserSiteOperationRead>(),
  saveBrowserSiteOperation:
    vi.fn<typeof siteOperationsService.saveBrowserSiteOperation>(),
}));
vi.mock("@db/services/browser-site-operations", () => records);
vi.mock("@db/services/settings", () => ({
  getWorkspaceModelId: () => Promise.resolve("deepseek/deepseek-v4.1-flash"),
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: () => Promise.resolve("Europe/Moscow"),
}));

const scope = { userId: "better-auth:alice", workspaceId: "personal:alice" };
const errand =
  "Найди 5 вакансий продакт-менеджера в Москве с зарплатой от 300 000 ₽";
const vacancies: Extract<BrowserVmSiteRead, { ok: true }> = {
  cards: [
    {
      link: "https://hh.ru/vacancy/138625702",
      more: { "company.visibleName": "Unagrande Company" },
      name: "Продакт-менеджер",
      price: 300000,
    },
  ],
  count: 50,
  fit: "exact",
  ms: 1800,
  ok: true,
  via: "fetch",
};

async function direct(pilot = "*", cold = "") {
  vi.resetModules();
  vi.stubEnv("BROWSER_SITE_OPS_WORKSPACES", pilot);
  vi.stubEnv("BROWSER_SITE_API_WORKSPACES", pilot);
  vi.stubEnv("BROWSER_SITE_COLD_WORKSPACES", cold);
  return import("@agent/lib/browser-vm/site-ops/direct");
}

function filled(
  url: string | null,
  operation: string | null = "hh.ru/search/vacancy"
) {
  model.generateText.mockResolvedValue({
    output: {
      limit: 5,
      operation,
      priceMax: null,
      priceMin: 300000,
      sort: "site",
      url,
    },
  });
}

function kettles(
  prices: readonly number[],
  from = 0
): Extract<BrowserVmSiteRead, { ok: true }> {
  return {
    cards: prices.map((price, index) => ({
      link: `https://www.ozon.ru/product/${String(from + index)}/`,
      more: {},
      name: `Чайник ${String(from + index)}`,
      price,
    })),
    count: 36,
    fit: "exact",
    ms: 900,
    ok: true,
    via: "fetch",
  };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  clearBrowserVmSettings();
});

describe("Bro's own read of a site it has read before", () => {
  it("answers a search from the site's data and counts the read for its operation", async () => {
    const { readSiteDirectly, siteApiPilot, siteReadNote } = await direct();
    expect(siteApiPilot(scope)).toBe(true);
    const url =
      "https://hh.ru/search/vacancy?text=%D0%BF%D1%80%D0%BE%D0%B4%D0%B0%D0%BA%D1%82&area=1&salary=300000&only_with_salary=true";
    // A key the page does not have is left out, not the read.
    filled(`${url}&sort=price_asc`);
    browser.readBrowserVmSiteDirectly.mockResolvedValue(vacancies);
    const read = await readSiteDirectly(scope, {
      errand,
      note: undefined,
      sessionId: "s1",
      site: "https://hh.ru",
    });
    expect(read).toEqual({
      cards: vacancies.cards,
      count: 50,
      from: "data",
      more: true,
      order: "relevance",
      page: 0,
      url,
    });
    const [[workspace, asked] = []] =
      browser.readBrowserVmSiteDirectly.mock.calls;
    expect(workspace).toBe(scope.workspaceId);
    expect(asked?.operation.name).toBe("hh.ru/search/vacancy");
    expect({
      limit: asked?.limit,
      priceMin: asked?.priceMin,
      url: asked?.url,
    }).toEqual({
      limit: 12,
      priceMin: 300000,
      url,
    });
    expect(records.noteBrowserSiteOperationRead).toHaveBeenCalledWith(
      scope.workspaceId,
      expect.objectContaining({ name: "hh.ru/search/vacancy" }),
      { direct: true, ok: true }
    );
    expect(
      siteReadNote({
        cards: [],
        count: 0,
        from: "data",
        more: false,
        order: "relevance",
        page: 0,
        url,
        ...read,
      })
    ).toContain("call browser_task start again");
    // A first look's cards are the page's own order, and the note says so.
    expect(
      siteReadNote({
        cards: [],
        count: 0,
        from: "page",
        more: false,
        order: "page",
        page: 0,
        url,
      })
    ).toContain("neither filtered nor sorted");
    // A second start on the site in the session wants what the read did not give: the browser.
    expect(
      await readSiteDirectly(scope, {
        errand,
        note: undefined,
        sessionId: "s1",
        site: "https://www.hh.ru",
      })
    ).toBeUndefined();
    expect(browser.readBrowserVmSiteDirectly).toHaveBeenCalledTimes(1);
  });

  it("has the site sort its whole search by price, reads the order back, and pages the same search when asked for more", async () => {
    const { readSiteDirectly, siteReadNote } = await direct();
    const site = {
      errand: "Найди на Озоне самые дешёвые чайники до 3000 ₽",
      note: undefined,
      site: "https://www.ozon.ru",
    };
    const fillOzon = (more: boolean) => {
      model.generateText.mockResolvedValue({
        output: {
          limit: 5,
          more,
          operation: "www.ozon.ru/search/",
          priceMax: 3000,
          priceMin: null,
          sort: "price_asc",
          url: "https://www.ozon.ru/search/?text=чайник&deny_category_prediction=true",
        },
      });
    };
    const askedOf = (call: number) => {
      const asked = browser.readBrowserVmSiteDirectly.mock.calls[call]?.[1];
      const address = new URL(asked?.url ?? "https://none.invalid/");
      return { address, limit: asked?.limit, sort: asked?.sort };
    };
    fillOzon(false);
    browser.readBrowserVmSiteDirectly.mockResolvedValue(
      kettles([103, 129, 165, 176, 178])
    );
    const read = await readSiteDirectly(scope, { ...site, sessionId: "o" });
    // The site's own pairs and price key; its order is kept and read back.
    const first = askedOf(0);
    expect(first.sort).toBe("site");
    expect(first.limit).toBe(20);
    expect(first.address.searchParams.get("sorting")).toBe("price");
    expect(first.address.searchParams.get("currency_price")).toBe(
      "0.000;3000.000"
    );
    expect(read?.order).toBe("site");
    expect(read?.more).toBe(true);
    if (read === undefined) throw new Error("no read");
    expect(siteReadNote(read)).toContain("sorted everything it found");
    // More of the same search is its next page, with nothing shown again —
    // whatever words the fill gives the search this time.
    model.generateText.mockResolvedValue({
      output: {
        limit: null,
        more: true,
        operation: "www.ozon.ru/search/",
        priceMax: null,
        priceMin: null,
        sort: "site",
        url: "https://www.ozon.ru/search/?text=электрический+чайник&deny_category_prediction=true",
      },
    });
    browser.readBrowserVmSiteDirectly.mockResolvedValue({
      ...kettles([178, 205, 207], 4),
    });
    const next = await readSiteDirectly(scope, { ...site, sessionId: "o" });
    const second = askedOf(1);
    expect(second.address.searchParams.get("page")).toBe("2");
    expect(second.address.searchParams.get("text")).toBe("чайник");
    expect(second.address.searchParams.get("sorting")).toBe("price");
    expect(second.address.searchParams.get("currency_price")).toBe(
      "0.000;3000.000"
    );
    expect(second.sort).toBe("site");
    expect(next?.page).toBe(1);
    expect(next?.cards.map(({ link }) => link)).toEqual([
      "https://www.ozon.ru/product/5/",
      "https://www.ozon.ru/product/6/",
    ]);
    if (next === undefined) throw new Error("no next page");
    expect(siteReadNote(next)).toContain("page 2 of the same search");
    // «More» with other words, or a new bound, is a new search: the site's pages.
    for (const output of [
      { priceMax: null, url: "https://www.ozon.ru/search/?text=утюг" },
      { priceMax: 2000, url: "https://www.ozon.ru/search/?text=чайник" },
    ]) {
      model.generateText.mockResolvedValue({
        output: {
          limit: null,
          more: true,
          operation: "www.ozon.ru/search/",
          priceMin: null,
          sort: "site",
          ...output,
        },
      });
      expect(
        // oxlint-disable-next-line eslint/no-await-in-loop -- each start follows the one before in the session
        await readSiteDirectly(scope, { ...site, sessionId: "o" })
      ).toBeUndefined();
    }
    // The same search again without asking for more wants the site's pages.
    fillOzon(false);
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "o" })
    ).toBeUndefined();
    expect(browser.readBrowserVmSiteDirectly).toHaveBeenCalledTimes(2);
    // A site that no longer sorts as asked: its page's cards are sorted here.
    fillOzon(false);
    browser.readBrowserVmSiteDirectly.mockResolvedValue(
      kettles([500, 100, 900, 50, 300])
    );
    const unsorted = await readSiteDirectly(scope, {
      ...site,
      sessionId: "p",
    });
    expect(unsorted?.order).toBe("picked");
    expect(unsorted?.cards.map(({ price }) => price)).toEqual([
      50, 100, 300, 500, 900,
    ]);
    if (unsorted === undefined) throw new Error("no read");
    expect(siteReadNote(unsorted)).toContain("not of everything it has");
    // Its cheapest name nothing searched (accessories): the search's own
    // order is read and sorted here.
    fillOzon(false);
    browser.readBrowserVmSiteDirectly
      .mockResolvedValueOnce({
        fit: "exact",
        ms: 900,
        ok: false,
        reason: "unanswered",
      })
      .mockResolvedValueOnce(kettles([1494, 1024, 3208]));
    const relevant = await readSiteDirectly(scope, {
      ...site,
      sessionId: "q",
    });
    const plain = askedOf(4);
    expect(plain.address.searchParams.has("sorting")).toBe(false);
    expect(plain.sort).toBe("price_asc");
    expect(relevant?.order).toBe("picked");
  });

  it("reads the pages of the site an errand names, once a session, and leaves a results page to the search", async () => {
    const { itemLinks, itemReadNote, readItemsDirectly } = await direct();
    const hh = "https://hh.ru";
    expect(
      itemLinks(
        "Сравни https://hh.ru/vacancy/1, http://spb.hh.ru/vacancy/2. и https://evil.ru/vacancy/3, https://hh.ru/vacancy/4",
        hh,
        []
      )
    ).toEqual(["https://hh.ru/vacancy/1", "https://spb.hh.ru/vacancy/2"]);
    // The site's own front page and a results page of its operation, on a
    // city's host or with Bro's own sort and page beside it, are no item; a
    // page of as many parts as the results page is.
    expect(
      itemLinks(
        "https://hh.ru/ и https://spb.hh.ru/search/vacancy?text=x&order_by=salary_desc&page=1 и https://hh.ru/vacancy/5",
        hh,
        knownSiteOperations.filter(({ name }) => name.startsWith("hh.ru"))
      )
    ).toEqual(["https://hh.ru/vacancy/5"]);
    // A link with credentials before the host, or a port, is no page of the site's.
    expect(
      itemLinks(
        "https://me@hh.ru/vacancy/6 https://hh.ru:8443/vacancy/7 https://hh.ru/@me/vacancy/8",
        hh,
        []
      )
    ).toEqual(["https://hh.ru/@me/vacancy/8"]);
    const asked = "Какая зарплата в https://hh.ru/vacancy/138625702?";
    // A link with «the cheapest» is a search: its page is never read as one item.
    model.generateText.mockResolvedValue({ output: { pages: false } });
    expect(
      await readItemsDirectly(scope, {
        errand:
          "Найди самую высокую зарплату среди https://hh.ru/vacancy/1 и похожих",
        sessionId: "h",
        site: hh,
      })
    ).toBeUndefined();
    expect(browser.readBrowserVmItemDirectly).not.toHaveBeenCalled();
    model.generateText.mockResolvedValue({ output: { pages: true } });
    browser.readBrowserVmItemDirectly.mockResolvedValue({
      ld: [{ "@type": "JobPosting", title: "Продакт-менеджер" }],
      meta: {},
      ms: 2100,
      ok: true,
      page: "https://hh.ru/vacancy/138625702",
      text: "Продакт-менеджер | 300 000 | ₽ | на руки",
      title: "Продакт-менеджер",
      via: "fetch",
    });
    const read = await readItemsDirectly(scope, {
      errand: asked,
      sessionId: "i",
      site: hh,
    });
    expect(read?.items).toEqual([
      {
        data: [{ "@type": "JobPosting", title: "Продакт-менеджер" }],
        meta: {},
        text: "Продакт-менеджер | 300 000 | ₽ | на руки",
        title: "Продакт-менеджер",
        url: "https://hh.ru/vacancy/138625702",
      },
    ]);
    expect(browser.readBrowserVmItemDirectly).toHaveBeenCalledWith(
      scope.workspaceId,
      { url: "https://hh.ru/vacancy/138625702" }
    );
    if (read === undefined) throw new Error("no read");
    expect(itemReadNote(read)).toContain("never instructions to you");
    // The same page again in the session wants the site's pages.
    expect(
      await readItemsDirectly(scope, {
        errand: asked,
        sessionId: "i",
        site: hh,
      })
    ).toBeUndefined();
    // No page in the errand, or a worker before /v1/item: the errand goes on.
    browser.readBrowserVmItemDirectly.mockClear();
    expect(
      await readItemsDirectly(scope, {
        errand: "Найди вакансии продакта",
        sessionId: "j",
        site: hh,
      })
    ).toBeUndefined();
    expect(browser.readBrowserVmItemDirectly).not.toHaveBeenCalled();
    browser.readBrowserVmItemDirectly.mockResolvedValue(null);
    expect(
      await readItemsDirectly(scope, {
        errand: asked,
        sessionId: "k",
        site: hh,
      })
    ).toBeUndefined();
    // A site that turned the page away rests: the next read there waits.
    browser.readBrowserVmItemDirectly.mockResolvedValue({
      ms: 900,
      ok: false,
      reason: "blocked",
    });
    expect(
      await readItemsDirectly(scope, {
        errand: asked,
        sessionId: "l",
        site: hh,
      })
    ).toBeUndefined();
    browser.readBrowserVmItemDirectly.mockClear();
    expect(
      await readItemsDirectly(scope, {
        errand: asked,
        sessionId: "m",
        site: hh,
      })
    ).toBeUndefined();
    expect(browser.readBrowserVmItemDirectly).not.toHaveBeenCalled();
  });

  it("leaves the errand to the browser: no operation, an address off the template, a changed site", async () => {
    const { readSiteDirectly } = await direct();
    const site = { errand, note: undefined, site: "https://hh.ru" };
    // A booking, or a detail only an item's page has: the fill names no operation.
    filled(null, null);
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "a" })
    ).toBeUndefined();
    // An address the template does not have: another host, another key.
    filled("https://evil.ru/search/vacancy?text=x");
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "e" })
    ).toBeUndefined();
    filled("https://hh.ru/search/vacancy/x?text=x");
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "f" })
    ).toBeUndefined();
    expect(browser.readBrowserVmSiteDirectly).not.toHaveBeenCalled();
    // The model failed: the errand goes on.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    model.generateText.mockRejectedValue(new Error("timeout"));
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "b" })
    ).toBeUndefined();
    // The sandbox's worker is older than the operation needs: nothing is read
    // and nothing counts against the operation.
    filled("https://hh.ru/search/vacancy?text=x");
    browser.readBrowserVmSiteDirectly.mockResolvedValue(null);
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "w" })
    ).toBeUndefined();
    expect(records.noteBrowserSiteOperationRead).not.toHaveBeenCalled();
    // The site no longer holds its results there: counted against the operation.
    browser.readBrowserVmSiteDirectly.mockResolvedValue({
      fit: "exact",
      ms: 900,
      ok: false,
      reason: "no_data",
    });
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "c" })
    ).toBeUndefined();
    expect(records.noteBrowserSiteOperationRead).toHaveBeenCalledWith(
      scope.workspaceId,
      expect.objectContaining({ name: "hh.ru/search/vacancy" }),
      { ok: false, reason: "no_data" }
    );
    // A site that turned the browser away says nothing of the operation.
    records.noteBrowserSiteOperationRead.mockClear();
    browser.readBrowserVmSiteDirectly.mockResolvedValue({
      fit: "exact",
      ms: 900,
      ok: false,
      reason: "blocked",
    });
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "d" })
    ).toBeUndefined();
    expect(records.noteBrowserSiteOperationRead).not.toHaveBeenCalled();
    // …and the site rests for a while: the next search there goes straight to
    // the browser, with no fill and no read.
    model.generateText.mockClear();
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "g" })
    ).toBeUndefined();
    expect(model.generateText).not.toHaveBeenCalled();
  });

  it("is only the pilot's, and widens a workspace's own find that read another city", async () => {
    const outside = await direct("personal:bob");
    expect(outside.siteApiPilot(scope)).toBe(false);
    const { readSiteDirectly } = await direct();
    const camry = {
      fields: { link: { path: ["url"] }, name: ["name"], price: ["price"] },
      items: ["offers", "offers"],
      name: "auto.drom.ru/toyota/camry/",
      page: "https://auto.drom.ru/toyota/camry/",
      seen: { items: 20, matched: 6, of: 6 },
      source: {
        kind: "document",
        state: { index: 0, tag: "script", type: "application/ld+json" },
      },
    };
    records.listBrowserSiteOperations.mockResolvedValue([
      {
        adopted: false,
        createdAt: new Date(),
        failedAt: null,
        failures: 0,
        host: "auto.drom.ru",
        id: "1",
        lastFailure: null,
        name: camry.name,
        operation: camry,
        runs: 3,
        served: 0,
        updatedAt: new Date(),
        workspaceId: scope.workspaceId,
      },
    ]);
    filled("https://auto.drom.ru/kia/rio/", camry.name);
    browser.readBrowserVmSiteDirectly.mockResolvedValue({
      ...vacancies,
      fit: "loose",
    });
    const read = await readSiteDirectly(scope, {
      errand: "Подбери Kia Rio на drom до 1,2 млн",
      note: undefined,
      sessionId: "s2",
      site: "https://auto.drom.ru",
    });
    expect(read?.url).toBe("https://auto.drom.ru/kia/rio/");
    expect(records.saveBrowserSiteOperation).toHaveBeenCalledWith(
      scope.workspaceId,
      expect.objectContaining({ name: "auto.drom.ru/%word%/%word%/", runs: 3 })
    );
    expect(records.deleteBrowserSiteOperation).toHaveBeenCalledWith(
      scope.workspaceId,
      camry.name
    );
    // The section's find is the site's: an errand that names drom.ru reads it,
    // and a page that turned the browser away rests drom.ru, not the host the
    // operation read.
    model.generateText.mockClear();
    filled("https://auto.drom.ru/kia/rio/", camry.name);
    browser.readBrowserVmSiteDirectly.mockResolvedValue({
      fit: "exact",
      ms: 900,
      ok: false,
      reason: "blocked",
    });
    const errandOnSite = {
      errand: "Подбери Kia Rio на drom до 1,2 млн",
      note: undefined,
      site: "https://drom.ru",
    };
    expect(
      await readSiteDirectly(scope, { ...errandOnSite, sessionId: "s3" })
    ).toBeUndefined();
    expect(model.generateText).toHaveBeenCalledTimes(1);
    model.generateText.mockClear();
    expect(
      await readSiteDirectly(scope, {
        ...errandOnSite,
        sessionId: "s4",
        site: "https://www.drom.ru",
      })
    ).toBeUndefined();
    expect(model.generateText).not.toHaveBeenCalled();
  });

  it("looks at the results page a model names on a site with no operation, and keeps the one behind its cards", async () => {
    const site = {
      errand: "Найди 5 самых дешёвых пылесосов на Ситилинке",
      note: undefined,
      site: "https://www.citilink.ru",
    };
    // Outside the first-look pilot a site with no operation is the browser's.
    const outside = await direct("*", "");
    expect(
      await outside.readSiteDirectly(scope, { ...site, sessionId: "o" })
    ).toBeUndefined();
    expect(model.generateText).not.toHaveBeenCalled();
    const { readSiteDirectly, siteColdPilot } = await direct("*", "*");
    expect(siteColdPilot(scope)).toBe(true);
    // A page off the site is not looked at.
    model.generateText.mockResolvedValue({
      output: { query: "пылесос", url: "https://evil.ru/search/?text=x" },
    });
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "x" })
    ).toBeUndefined();
    expect(browser.lookBrowserVmSiteDirectly).not.toHaveBeenCalled();
    // …and the site is not asked about again for a while.
    model.generateText.mockClear();
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "y" })
    ).toBeUndefined();
    expect(model.generateText).not.toHaveBeenCalled();
    const fresh = await direct("*", "*");
    const page = "https://www.citilink.ru/search/?text=пылесос&sort=price";
    model.generateText.mockResolvedValue({
      output: { query: "пылесос", url: page },
    });
    const operation = {
      fields: { link: { path: ["url"] }, name: ["name"], price: ["price"] },
      items: ["products"],
      name: "citilink.ru/search/",
      page: "https://citilink.ru/search/?text=%query%",
      seen: { items: 36, matched: 6, of: 6 },
      source: {
        kind: "document",
        state: { index: 0, tag: "script", type: "application/json" },
      },
    };
    browser.lookBrowserVmSiteDirectly.mockResolvedValue({
      cards: [
        {
          link: "https://www.citilink.ru/product/1/",
          text: "Пылесос Kitfort KT-5307 4 990 ₽",
          title: "Пылесос Kitfort KT-5307",
        },
      ],
      count: 36,
      ms: 5200,
      ok: true,
      operations: [operation],
      page,
    });
    const read = await fresh.readSiteDirectly(scope, {
      ...site,
      sessionId: "z",
    });
    expect(read).toEqual({
      cards: [
        {
          link: "https://www.citilink.ru/product/1/",
          more: { text: "Пылесос Kitfort KT-5307 4 990 ₽" },
          name: "Пылесос Kitfort KT-5307",
        },
      ],
      count: 36,
      from: "page",
      more: false,
      order: "page",
      page: 0,
      url: new URL(page).href,
    });
    expect(browser.lookBrowserVmSiteDirectly).toHaveBeenCalledWith(
      scope.workspaceId,
      { url: new URL(page).href, words: "пылесос" }
    );
    expect(records.saveBrowserSiteOperation).toHaveBeenCalledWith(
      scope.workspaceId,
      expect.objectContaining({ name: "citilink.ru/search/" })
    );
  });

  it("gives a site back when its look failed for no fault of its own, and rests the workspace only when the worker cannot look", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { readSiteDirectly } = await direct("*", "*");
    // The worker's error class as the module just loaded holds it.
    const { BrowserVmWorkerError } =
      await import("@agent/lib/browser-vm/worker");
    const site = {
      errand: "Найди 5 вакансий сварщика",
      note: undefined,
      site: "https://www.rabota.ru",
    };
    const page = "https://www.rabota.ru/vacancy/?query=сварщик";
    model.generateText.mockResolvedValue({
      output: { query: "сварщик", url: page },
    });
    // The model failed to name a page: the site is looked at by the next errand.
    model.generateText.mockRejectedValueOnce(new Error("timeout"));
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "t1" })
    ).toBeUndefined();
    expect(browser.lookBrowserVmSiteDirectly).not.toHaveBeenCalled();
    // The page answered no list of results: not again for a while.
    browser.lookBrowserVmSiteDirectly.mockResolvedValueOnce({
      ms: 4000,
      ok: false,
      reason: "unanswered",
    });
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "t2" })
    ).toBeUndefined();
    expect(browser.lookBrowserVmSiteDirectly).toHaveBeenCalledTimes(1);
    expect(
      await readSiteDirectly(scope, { ...site, sessionId: "t3" })
    ).toBeUndefined();
    expect(browser.lookBrowserVmSiteDirectly).toHaveBeenCalledTimes(1);
    // A look that ran out of time rests that site, not the others.
    model.generateText.mockResolvedValue({
      output: {
        query: "сварщик",
        url: "https://zarplata.ru/vacancy?q=сварщик",
      },
    });
    browser.lookBrowserVmSiteDirectly.mockRejectedValueOnce(
      new Error("timeout")
    );
    expect(
      await readSiteDirectly(scope, {
        ...site,
        sessionId: "t3a",
        site: "https://zarplata.ru",
      })
    ).toBeUndefined();
    model.generateText.mockClear();
    expect(
      await readSiteDirectly(scope, {
        ...site,
        sessionId: "t3b",
        site: "https://zarplata.ru",
      })
    ).toBeUndefined();
    expect(model.generateText).not.toHaveBeenCalled();
    // No words to check a page against: no look at all.
    model.generateText.mockResolvedValue({
      output: { query: null, url: "https://www.superjob.ru/vacancy/search/" },
    });
    expect(
      await readSiteDirectly(scope, {
        ...site,
        sessionId: "t4",
        site: "https://www.superjob.ru",
      })
    ).toBeUndefined();
    expect(browser.lookBrowserVmSiteDirectly).toHaveBeenCalledTimes(2);
    // A worker that has no look rests every site of the workspace: the next
    // errand does not pay for the model or the call again.
    model.generateText.mockResolvedValue({
      output: { query: "диван", url: "https://www.avito.ru/moskva?q=диван" },
    });
    browser.lookBrowserVmSiteDirectly.mockRejectedValueOnce(
      new BrowserVmWorkerError(404, "/v1/look", "not found")
    );
    expect(
      await readSiteDirectly(scope, {
        ...site,
        sessionId: "t5",
        site: "https://www.avito.ru",
      })
    ).toBeUndefined();
    model.generateText.mockClear();
    expect(
      await readSiteDirectly(scope, {
        ...site,
        sessionId: "t6",
        site: "https://www.detmir.ru",
      })
    ).toBeUndefined();
    expect(model.generateText).not.toHaveBeenCalled();
  });
});

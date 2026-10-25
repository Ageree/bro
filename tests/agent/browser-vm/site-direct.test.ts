import type * as ai from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as siteOperationsService from "@db/services/browser-site-operations";
import type * as browserVmRuns from "@agent/lib/browser-vm/runs";
import type { BrowserVmSiteRead } from "@agent/lib/browser-vm/worker";
import { clearBrowserVmSettings } from "../../helpers/browser-vm";

/** What the fill's model answers (`fillSiteRead`). */
interface Filled {
  output: {
    limit: number | null;
    operation: string | null;
    priceMax: number | null;
    priceMin: number | null;
    sort: "price_asc" | "price_desc" | "site" | null;
    url: string | null;
  };
}
const model = vi.hoisted(() => ({
  generateText: vi.fn<(input: { prompt: string }) => Promise<Filled>>(),
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof ai>()),
  generateText: model.generateText,
}));
const browser = vi.hoisted(() => ({
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

async function direct(pilot = "*") {
  vi.resetModules();
  vi.stubEnv("BROWSER_SITE_OPS_WORKSPACES", pilot);
  vi.stubEnv("BROWSER_SITE_API_WORKSPACES", pilot);
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
    expect(read).toEqual({ cards: vacancies.cards, count: 50, url });
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
    expect(siteReadNote({ cards: [], count: 0, url, ...read })).toContain(
      "call browser_task start again"
    );
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
    // The site no longer holds its results there: counted against the operation.
    filled("https://hh.ru/search/vacancy?text=x");
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
  });
});

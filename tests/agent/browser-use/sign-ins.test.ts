import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as browserUseClient from "@agent/lib/browser-use/client";

const workspaceId = "workspace:alice";

interface DueRefresh {
  accountUrl: string | null;
  domain: string;
  profileId: string;
  workspaceId: string;
}

const listDueBrowserSignInRefreshes = vi.hoisted(() =>
  vi.fn<
    (options: {
      dueBefore: Date;
      excludedDomains: readonly string[];
      limit: number;
      usedAfter: Date;
    }) => Promise<DueRefresh[]>
  >(() => Promise.resolve([]))
);
const claimBrowserSignInRefresh = vi.hoisted(() =>
  vi.fn<
    (
      workspaceId: string,
      domain: string,
      options: { dueBefore: Date; now: Date }
    ) => Promise<boolean>
  >(() => Promise.resolve(true))
);
const recordBrowserSignInCheck = vi.hoisted(() =>
  vi.fn<
    (
      workspaceId: string,
      domain: string,
      input: { now: Date; signedIn: boolean }
    ) => Promise<void>
  >(() => Promise.resolve())
);
const listWorkspacesHoldingBrowsers = vi.hoisted(() =>
  vi.fn<(workspaceIds: readonly string[]) => Promise<string[]>>(() =>
    Promise.resolve([])
  )
);
const listBrowserHoldingSites = vi.hoisted(() =>
  vi.fn<(workspaceId: string) => Promise<(string | null)[]>>(() =>
    Promise.resolve([])
  )
);
const createBrowserUseBrowser = vi.hoisted(() =>
  vi.fn<
    (input: {
      customProxy: unknown;
      profileId: string;
      proxyCountryCode: string;
      timeoutMinutes: number;
    }) => Promise<{ cdpUrl: string; id: string }>
  >()
);
const stopBrowserUseBrowser = vi.hoisted(() =>
  vi.fn<(browserId: string) => Promise<void>>(() => Promise.resolve())
);
const visitPageOverCdp = vi.hoisted(() =>
  vi.fn<
    (
      cdpUrl: string,
      url: string
    ) => Promise<{ passwordField: boolean; url: string }>
  >()
);

vi.mock("@db/services/browser-sign-ins", () => ({
  claimBrowserSignInRefresh,
  listDueBrowserSignInRefreshes,
  readBrowserSignIns: () => Promise.resolve([]),
  recordBrowserSignIn: () => Promise.resolve(),
  recordBrowserSignInCheck,
  recordBrowserSignOut: () => Promise.resolve(),
}));
vi.mock("@db/services/browser-runs", () => ({
  listBrowserHoldingSites,
  listWorkspacesHoldingBrowsers,
}));
vi.mock("@agent/lib/browser-use/client", async (importOriginal) => ({
  ...(await importOriginal<typeof browserUseClient>()),
  createBrowserUseBrowser,
  stopBrowserUseBrowser,
}));
vi.mock("@agent/lib/browser-use/cdp", () => ({ visitPageOverCdp }));

function due(domain: string, accountUrl: string, workspace = workspaceId) {
  return { accountUrl, domain, profileId: "profile-1", workspaceId: workspace };
}

beforeEach(() => {
  claimBrowserSignInRefresh.mockResolvedValue(true);
  listBrowserHoldingSites.mockResolvedValue([]);
  listDueBrowserSignInRefreshes.mockResolvedValue([]);
  listWorkspacesHoldingBrowsers.mockResolvedValue([]);
  visitPageOverCdp.mockReset();
  createBrowserUseBrowser.mockReset();
  createBrowserUseBrowser.mockImplementation(() =>
    Promise.resolve({ cdpUrl: "wss://cdp.example/browser-1", id: "browser-1" })
  );
});

afterEach(() => {
  // Clearing every stub would also drop the values tests/setup-env.ts installs.
  vi.stubEnv("BROWSER_USE_SIGN_IN_REFRESH_DAYS", "");
  vi.clearAllMocks();
});

describe("the account a sign-in belongs to", () => {
  it("puts every site that signs in through Госуслуги on one account", async () => {
    const { accountInUse } = await import("@agent/lib/browser-use/sign-ins");
    const held = async (holding: string, site: string | null) => {
      listBrowserHoldingSites.mockResolvedValue([holding]);
      return accountInUse(workspaceId, site);
    };

    expect(await held("https://www.gosuslugi.ru", "https://emias.info")).toBe(
      "gosuslugi.ru"
    );
    expect(
      await held("https://emias.info", "https://www.mos.ru/services")
    ).toBe("gosuslugi.ru");
    expect(
      await held("https://market.yandex.ru", "https://taxi.yandex.ru")
    ).toBe("yandex.ru");
    // A shop on a shared suffix is its own account; the suffix is nobody's.
    expect(
      await held("https://shop.tilda.ws", "https://other.tilda.ws")
    ).toBeUndefined();
    expect(await held("https://tilda.ws", "https://tilda.ws")).toBeUndefined();
    expect(await held("https://www.ozon.ru", null)).toBeUndefined();
  });

  it("waits only on another browser of the same account", async () => {
    const { accountInUse } = await import("@agent/lib/browser-use/sign-ins");
    listBrowserHoldingSites.mockResolvedValue([
      "https://www.ozon.ru",
      null,
      "https://emias.info",
    ]);

    expect(await accountInUse(workspaceId, "https://www.mos.ru")).toBe(
      "gosuslugi.ru"
    );
    expect(await accountInUse(workspaceId, "https://www.ozon.ru")).toBe(
      "ozon.ru"
    );
    expect(
      await accountInUse(workspaceId, "https://www.wildberries.ru")
    ).toBeUndefined();
    expect(await accountInUse(workspaceId, undefined)).toBeUndefined();
  });
});

describe("keeping sign-ins alive", () => {
  it("opens a due account page on the profile and stops the browser, which keeps its cookies", async () => {
    listDueBrowserSignInRefreshes.mockResolvedValue([
      due("ozon.ru", "https://www.ozon.ru/my/main"),
    ]);
    visitPageOverCdp.mockResolvedValue({
      passwordField: false,
      url: "https://www.ozon.ru/my/main",
    });
    const { refreshDueSignIns } =
      await import("@agent/lib/browser-use/sign-ins");
    const now = new Date("2026-09-30T10:00:00.000Z");

    await refreshDueSignIns(now);

    const listed = listDueBrowserSignInRefreshes.mock.calls[0]?.[0];
    // Every three days by default, for sites used within a month, never on
    // Госуслуги.
    expect(listed?.dueBefore).toEqual(new Date("2026-09-27T10:00:00.000Z"));
    expect(listed?.usedAfter).toEqual(new Date("2026-08-31T10:00:00.000Z"));
    expect(listed?.excludedDomains).toEqual(["gosuslugi.ru"]);
    expect(createBrowserUseBrowser).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ profileId: "profile-1", timeoutMinutes: 3 })
    );
    expect(visitPageOverCdp).toHaveBeenCalledExactlyOnceWith(
      "wss://cdp.example/browser-1",
      "https://www.ozon.ru/my/main"
    );
    expect(stopBrowserUseBrowser).toHaveBeenCalledExactlyOnceWith("browser-1");
    expect(recordBrowserSignInCheck).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      "ozon.ru",
      expect.objectContaining({ signedIn: true })
    );
  });

  it("records a page that turned into a sign-in, and asks nobody", async () => {
    listDueBrowserSignInRefreshes.mockResolvedValue([
      due("yandex.ru", "https://taxi.yandex.ru/order"),
      due("wildberries.ru", "https://www.wildberries.ru/lk"),
      due("ozon.ru", "https://www.ozon.ru/my/main"),
    ]);
    visitPageOverCdp
      .mockResolvedValueOnce({
        passwordField: false,
        url: "https://passport.yandex.ru/auth?retpath=taxi",
      })
      .mockResolvedValueOnce({
        passwordField: true,
        url: "https://www.wildberries.ru/lk",
      })
      .mockResolvedValueOnce({
        passwordField: false,
        url: "https://www.ozon.ru/my/main?login=1",
      });
    const { refreshDueSignIns } =
      await import("@agent/lib/browser-use/sign-ins");

    await refreshDueSignIns(new Date("2026-09-30T10:00:00.000Z"));

    expect(
      recordBrowserSignInCheck.mock.calls.map(([, domain, input]) => [
        domain,
        input.signedIn,
      ])
    ).toEqual([
      ["yandex.ru", false],
      ["wildberries.ru", false],
      ["ozon.ru", true],
    ]);
    expect(stopBrowserUseBrowser).toHaveBeenCalledTimes(3);
  });

  it("leaves a workspace with a browser up alone, and a visit another tick claimed", async () => {
    listDueBrowserSignInRefreshes.mockResolvedValue([
      due("ozon.ru", "https://www.ozon.ru/my/main", "workspace:busy"),
      due("ozon.ru", "https://www.ozon.ru/my/main"),
    ]);
    listWorkspacesHoldingBrowsers.mockResolvedValue(["workspace:busy"]);
    claimBrowserSignInRefresh.mockResolvedValue(false);
    const { refreshDueSignIns } =
      await import("@agent/lib/browser-use/sign-ins");

    await refreshDueSignIns(new Date("2026-09-30T10:00:00.000Z"));

    expect(claimBrowserSignInRefresh).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      "ozon.ru",
      expect.anything()
    );
    expect(createBrowserUseBrowser).not.toHaveBeenCalled();
  });

  it("stops the browser even when the visit fails, and ends the tick when Browser Use is full", async () => {
    const { BrowserUseError } = await import("@agent/lib/browser-use/client");
    listDueBrowserSignInRefreshes.mockResolvedValue([
      due("ozon.ru", "https://www.ozon.ru/my/main"),
      due("yandex.ru", "https://id.yandex.ru/"),
      due("wildberries.ru", "https://www.wildberries.ru/lk"),
    ]);
    visitPageOverCdp.mockRejectedValueOnce(new Error("debugger gone"));
    createBrowserUseBrowser
      .mockResolvedValueOnce({ cdpUrl: "wss://cdp.example/1", id: "browser-1" })
      .mockRejectedValueOnce(
        new BrowserUseError(429, "/browsers", "Too many concurrent sessions")
      );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { refreshDueSignIns } =
      await import("@agent/lib/browser-use/sign-ins");

    await refreshDueSignIns(new Date("2026-09-30T10:00:00.000Z"));

    expect(stopBrowserUseBrowser).toHaveBeenCalledExactlyOnceWith("browser-1");
    // An unanswered visit says nothing about the sign-in.
    expect(recordBrowserSignInCheck).not.toHaveBeenCalled();
    // The third one waits for the next tick instead of another 429.
    expect(createBrowserUseBrowser).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("does nothing when the owner turned the visits off", async () => {
    vi.stubEnv("BROWSER_USE_SIGN_IN_REFRESH_DAYS", "0");
    vi.resetModules();
    const { refreshDueSignIns } =
      await import("@agent/lib/browser-use/sign-ins");

    await refreshDueSignIns(new Date("2026-09-30T10:00:00.000Z"));

    expect(listDueBrowserSignInRefreshes).not.toHaveBeenCalled();
    vi.resetModules();
  });
});

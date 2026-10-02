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
interface HoldingRun {
  completedAt: Date | null;
  id: string;
  outcome: string | null;
  sessionId: string | null;
  site: string | null;
}

/** A run of the workspace still working in a browser on `site`. */
function working(
  site: string | null,
  id = `run-on-${String(site)}`
): HoldingRun {
  return {
    completedAt: null,
    id,
    outcome: null,
    sessionId: `session-${id}`,
    site,
  };
}

const listBrowserHoldingRuns = vi.hoisted(() =>
  vi.fn<(workspaceId: string) => Promise<HoldingRun[]>>(() =>
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
      url: string,
      domain: string
    ) => Promise<{ leftPage: boolean; passwordField: boolean; url: string }>
  >()
);
const forgetBrowserSignIns = vi.hoisted(() =>
  vi.fn<(workspaceId: string) => Promise<string[]>>(() => Promise.resolve([]))
);
const stopBrowserSignInRefresh = vi.hoisted(() =>
  vi.fn<(workspaceId: string, domain: string, now: Date) => Promise<void>>(() =>
    Promise.resolve()
  )
);
const forgetBrowserProfile = vi.hoisted(() =>
  vi.fn<(workspaceId: string, profileId: string) => Promise<void>>(() =>
    Promise.resolve()
  )
);
const readBrowserProfileId = vi.hoisted(() =>
  vi.fn<(scope: { workspaceId: string }) => Promise<string | undefined>>(() =>
    Promise.resolve("profile-1")
  )
);
// Every profile the workspace's errands ran on, the current one among them.
const listBrowserRunProfileIds = vi.hoisted(() =>
  vi.fn<(workspaceId: string) => Promise<string[]>>(() =>
    Promise.resolve(["profile-1"])
  )
);
const workspaceUsesBrowserProfile = vi.hoisted(() =>
  vi.fn<(workspaceId: string) => Promise<boolean>>(() => Promise.resolve(false))
);
const deleteBrowserUseProfile = vi.hoisted(() =>
  vi.fn<(profileId: string) => Promise<void>>(() => Promise.resolve())
);
const recordBrowserSignIn = vi.hoisted(() =>
  vi.fn<
    (
      workspaceId: string,
      input: { accountUrl: string | undefined; domain: string; now: Date }
    ) => Promise<void>
  >(() => Promise.resolve())
);
const alertOwner = vi.hoisted(() =>
  vi.fn<
    (
      key: string,
      text: string,
      options: { readonly repeatAfterMs: number }
    ) => Promise<boolean>
  >(() => Promise.resolve(true))
);

vi.mock("@agent/lib/owner-alert", () => ({
  alertOwner,
  clearOwnerAlert: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("@db/services/browser-sign-ins", () => ({
  claimBrowserSignInRefresh,
  forgetBrowserSignIns,
  listBrowserSignIns: () => Promise.resolve([]),
  listDueBrowserSignInRefreshes,
  readBrowserSignIns: () => Promise.resolve([]),
  recordBrowserSignIn,
  recordBrowserSignInCheck,
  recordBrowserSignOut: () => Promise.resolve(),
  stopBrowserSignInRefresh,
}));
vi.mock("@db/services/browser-runs", () => ({
  forgetBrowserProfile,
  listBrowserHoldingRuns,
  listBrowserRunProfileIds,
  listWorkspacesHoldingBrowsers,
  readBrowserProfileId,
  workspaceUsesBrowserProfile,
}));
vi.mock("@agent/lib/browser-use/client", async (importOriginal) => ({
  ...(await importOriginal<typeof browserUseClient>()),
  createBrowserUseBrowser,
  deleteBrowserUseProfile,
  stopBrowserUseBrowser,
}));
vi.mock("@agent/lib/browser-use/cdp", () => ({ visitPageOverCdp }));

function due(domain: string, accountUrl: string, workspace = workspaceId) {
  return { accountUrl, domain, profileId: "profile-1", workspaceId: workspace };
}

beforeEach(() => {
  claimBrowserSignInRefresh.mockResolvedValue(true);
  listBrowserHoldingRuns.mockResolvedValue([]);
  listDueBrowserSignInRefreshes.mockResolvedValue([]);
  listWorkspacesHoldingBrowsers.mockResolvedValue([]);
  visitPageOverCdp.mockReset();
  deleteBrowserUseProfile.mockReset();
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
      listBrowserHoldingRuns.mockResolvedValue([working(holding)]);
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
    listBrowserHoldingRuns.mockResolvedValue([
      working("https://www.ozon.ru"),
      working(null),
      working("https://emias.info"),
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

  it("waits for every page kept on the account, a staged one too", async () => {
    // Verification of wave 6: closing d07's staged slot for d08 sent the
    // confirmed follow-up to sign in to Госуслуги again, beside d08.
    const { accountInUse } = await import("@agent/lib/browser-use/sign-ins");
    const settled = (outcome: string): HoldingRun => ({
      ...working("https://www.gosuslugi.ru", outcome),
      completedAt: new Date(),
      outcome,
    });
    for (const outcome of [
      "Needs: decision",
      "Needs: payment",
      "Needs: address",
      "Needs: info",
      "Needs: sms_code",
    ]) {
      listBrowserHoldingRuns.mockResolvedValue([settled(outcome)]);
      // oxlint-disable-next-line eslint/no-await-in-loop -- One holding run per case.
      expect(await accountInUse(workspaceId, "https://emias.info")).toBe(
        "gosuslugi.ru"
      );
    }
  });
});

describe("keeping sign-ins alive", () => {
  it("opens a due account page on the profile and stops the browser, which keeps its cookies", async () => {
    listDueBrowserSignInRefreshes.mockResolvedValue([
      due("ozon.ru", "https://www.ozon.ru/my/main"),
    ]);
    visitPageOverCdp.mockResolvedValue({
      leftPage: false,
      passwordField: false,
      url: "https://www.ozon.ru/my/main/",
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
    // The visit may not leave the site it keeps alive.
    expect(visitPageOverCdp).toHaveBeenCalledExactlyOnceWith(
      "wss://cdp.example/browser-1",
      "https://www.ozon.ru/my/main",
      "ozon.ru"
    );
    expect(stopBrowserUseBrowser).toHaveBeenCalledExactlyOnceWith("browser-1");
    expect(recordBrowserSignInCheck).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      "ozon.ru",
      expect.objectContaining({ signedIn: true })
    );
  });

  it("counts any page but the recorded one as signed out, and asks nobody", async () => {
    listDueBrowserSignInRefreshes.mockResolvedValue([
      due("yandex.ru", "https://taxi.yandex.ru/order"),
      due("wildberries.ru", "https://www.wildberries.ru/lk"),
      due("ozon.ru", "https://www.ozon.ru/my/main"),
    ]);
    visitPageOverCdp
      // Sent to a sign-in on another site: the visit blocked it.
      .mockResolvedValueOnce({
        leftPage: true,
        passwordField: false,
        url: "https://taxi.yandex.ru/order",
      })
      .mockResolvedValueOnce({
        leftPage: false,
        passwordField: true,
        url: "https://www.wildberries.ru/lk",
      })
      // A session that ended sends the page home: the visit blocks it.
      .mockResolvedValueOnce({
        leftPage: true,
        passwordField: false,
        url: "https://www.ozon.ru/my/main",
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
      ["ozon.ru", false],
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

  it("skips only the visit of a workspace whose browser VM is off", async () => {
    const { BrowserUseError } = await import("@agent/lib/browser-use/client");
    const vmProfileId = "vm:workspace:vm-user:p1";
    listDueBrowserSignInRefreshes.mockResolvedValue([
      {
        ...due("ozon.ru", "https://www.ozon.ru/my/main", "workspace:vm-user"),
        profileId: vmProfileId,
      },
      due("yandex.ru", "https://id.yandex.ru/"),
    ]);
    visitPageOverCdp.mockResolvedValue({
      leftPage: false,
      passwordField: false,
      url: "https://id.yandex.ru/",
    });
    // A keep-alive never powers a VM on: one that is off answers 429.
    createBrowserUseBrowser
      .mockRejectedValueOnce(
        new BrowserUseError(429, "browser-vm", "The browser VM is off.")
      )
      .mockResolvedValueOnce({
        cdpUrl: "wss://cdp.example/2",
        id: "browser-2",
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { refreshDueSignIns } =
      await import("@agent/lib/browser-use/sign-ins");

    await refreshDueSignIns(new Date("2026-09-30T10:00:00.000Z"));

    expect(createBrowserUseBrowser.mock.calls[0]?.[0].profileId).toBe(
      vmProfileId
    );
    // The other workspace's visit still happens on this tick.
    expect(createBrowserUseBrowser).toHaveBeenCalledTimes(2);
    expect(recordBrowserSignInCheck).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      "yandex.ru",
      expect.objectContaining({ signedIn: true })
    );
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

describe("recording where a run is signed in", () => {
  it("never keeps a link that acts when opened", async () => {
    const { recordRunSignIns } =
      await import("@agent/lib/browser-use/sign-ins");

    for (const link of [
      "https://www.ozon.ru/%6Cogout",
      "https://www.ozon.ru/users/sign_out",
      "https://www.ozon.ru/logoff",
      "https://www.ozon.ru/api/doLogout",
      "https://logout.ozon.ru/",
      "https://www.ozon.ru/my/orders;logout",
      "https://www.ozon.ru/my/sessions/terminate",
      "https://www.ozon.ru/orders/1/cancelOrder",
      "https://www.ozon.ru/my/main?action=unsubscribe",
      "https://www.ozon.ru:8443/my/main",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One report at a time.
      await recordRunSignIns(
        { site: "https://www.ozon.ru", workspaceId },
        { needs: "none", signedIn: link, signedInNone: false }
      );
    }
    expect(recordBrowserSignIn).not.toHaveBeenCalled();

    await recordRunSignIns(
      { site: "https://www.ozon.ru", workspaceId },
      {
        needs: "none",
        signedIn: "https://www.ozon.ru/my/main?utm=1",
        signedInNone: false,
      }
    );
    expect(recordBrowserSignIn).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      expect.objectContaining({
        accountUrl: "https://www.ozon.ru/my/main",
        domain: "ozon.ru",
      })
    );
  });
});

describe("forgetting sign-ins", () => {
  const scope = { userId: "better-auth:alice", workspaceId };

  it("deletes the browser profile in the cloud first, then forgets it and every sign-in", async () => {
    forgetBrowserSignIns.mockResolvedValue(["ozon.ru", "yandex.ru"]);
    const { forgetSignIns } = await import("@agent/lib/browser-use/sign-ins");

    expect(await forgetSignIns(scope, undefined)).toEqual({
      domains: ["ozon.ru", "yandex.ru"],
      kind: "all",
    });
    expect(deleteBrowserUseProfile).toHaveBeenCalledExactlyOnceWith(
      "profile-1"
    );
    expect(forgetBrowserProfile).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      "profile-1"
    );
    expect(forgetBrowserSignIns).toHaveBeenCalledExactlyOnceWith(workspaceId);
  });

  it("forgets nothing when the cloud keeps the profile, and takes a missing one as gone", async () => {
    const { BrowserUseError } = await import("@agent/lib/browser-use/client");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    deleteBrowserUseProfile.mockRejectedValueOnce(
      new BrowserUseError(503, "/profiles/profile-1", "unavailable")
    );
    const { forgetSignIns } = await import("@agent/lib/browser-use/sign-ins");

    expect(await forgetSignIns(scope, undefined)).toEqual({ kind: "failed" });
    expect(forgetBrowserProfile).not.toHaveBeenCalled();
    expect(forgetBrowserSignIns).not.toHaveBeenCalled();

    deleteBrowserUseProfile.mockRejectedValueOnce(
      new BrowserUseError(404, "/profiles/profile-1", "not found")
    );
    expect(await forgetSignIns(scope, undefined)).toMatchObject({
      kind: "all",
    });
    expect(forgetBrowserProfile).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("deletes every profile the workspace ever ran on, on either backend", async () => {
    const { BrowserUseError } = await import("@agent/lib/browser-use/client");
    const vmProfile = `vm:${workspaceId}:p2`;
    // The workspace moved to its VM: its older errands ran on Browser Use,
    // on a profile since forgotten and on the one it had before the move.
    readBrowserProfileId.mockResolvedValueOnce(vmProfile);
    listBrowserRunProfileIds.mockResolvedValueOnce([
      "profile-0",
      "profile-1",
      vmProfile,
    ]);
    deleteBrowserUseProfile.mockImplementation((profileId) =>
      profileId === "profile-0"
        ? Promise.reject(
            new BrowserUseError(404, "/profiles/profile-0", "not found")
          )
        : Promise.resolve()
    );
    const { forgetSignIns } = await import("@agent/lib/browser-use/sign-ins");

    expect(await forgetSignIns(scope, undefined)).toMatchObject({
      kind: "all",
    });
    // The older ones go first; the current one only once they are gone.
    expect(
      deleteBrowserUseProfile.mock.calls.map(([profileId]) => profileId)
    ).toEqual(["profile-0", "profile-1", vmProfile]);
    expect(forgetBrowserProfile).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      vmProfile
    );
    expect(forgetBrowserSignIns).toHaveBeenCalledExactlyOnceWith(workspaceId);
  });

  it("forgets nothing for a real failure of an older profile", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vmProfile = `vm:${workspaceId}:p2`;
    readBrowserProfileId.mockResolvedValueOnce(vmProfile);
    listBrowserRunProfileIds.mockResolvedValueOnce(["profile-1", vmProfile]);
    deleteBrowserUseProfile.mockImplementation((profileId) =>
      profileId === "profile-1"
        ? Promise.reject(new Error("connection terminated"))
        : Promise.resolve()
    );
    const { forgetSignIns } = await import("@agent/lib/browser-use/sign-ins");

    expect(await forgetSignIns(scope, undefined)).toEqual({ kind: "failed" });
    // The current profile stays as it was, and so does every record: the
    // person hears nothing was forgotten, and can ask again.
    expect(deleteBrowserUseProfile).toHaveBeenCalledExactlyOnceWith(
      "profile-1"
    );
    expect(forgetBrowserProfile).not.toHaveBeenCalled();
    expect(forgetBrowserSignIns).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("does not block on an older Browser Use profile once this deployment has no key for it", async () => {
    const vmProfile = `vm:${workspaceId}:p2`;
    readBrowserProfileId.mockResolvedValueOnce(vmProfile);
    listBrowserRunProfileIds.mockResolvedValueOnce(["profile-1", vmProfile]);
    forgetBrowserSignIns.mockResolvedValue(["ozon.ru"]);
    // A deployment on VMs alone (the migration's end state) cannot reach
    // the Browser Use profile the workspace's older errands ran on, which
    // is still signed in there.
    deleteBrowserUseProfile.mockImplementation((profileId) =>
      profileId === "profile-1"
        ? Promise.reject(new Error("BROWSER_USE_API_KEY is not configured."))
        : Promise.resolve()
    );
    const { forgetSignIns } = await import("@agent/lib/browser-use/sign-ins");

    expect(await forgetSignIns(scope, undefined)).toEqual({
      domains: ["ozon.ru"],
      kind: "all",
    });
    // The current VM profile and the records are wiped all the same; the
    // unreachable older one is left for the owner to hear about.
    expect(forgetBrowserProfile).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      vmProfile
    );
    expect(forgetBrowserSignIns).toHaveBeenCalledExactlyOnceWith(workspaceId);
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.stringContaining("1"),
      expect.anything()
    );
  });

  it("still fails when the current profile has a real (retryable) failure", async () => {
    readBrowserProfileId.mockResolvedValueOnce("profile-1");
    listBrowserRunProfileIds.mockResolvedValueOnce(["profile-1"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    deleteBrowserUseProfile.mockRejectedValueOnce(
      new Error("connection terminated")
    );
    const { forgetSignIns } = await import("@agent/lib/browser-use/sign-ins");

    expect(await forgetSignIns(scope, undefined)).toEqual({ kind: "failed" });
    expect(forgetBrowserProfile).not.toHaveBeenCalled();
    expect(forgetBrowserSignIns).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not block on the current profile either, once this deployment has no key for it", async () => {
    // A workspace that has not run its first post-cutover errand yet still
    // points its *current* profile at an old Browser Use one — there is no
    // older profile here, so nothing falls back to the "others" tolerance.
    readBrowserProfileId.mockResolvedValueOnce("profile-1");
    listBrowserRunProfileIds.mockResolvedValueOnce(["profile-1"]);
    forgetBrowserSignIns.mockResolvedValue(["ozon.ru"]);
    deleteBrowserUseProfile.mockRejectedValueOnce(
      new Error("BROWSER_USE_API_KEY is not configured.")
    );
    const { forgetSignIns } = await import("@agent/lib/browser-use/sign-ins");

    expect(await forgetSignIns(scope, undefined)).toEqual({
      domains: ["ozon.ru"],
      kind: "all",
    });
    expect(forgetBrowserProfile).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      "profile-1"
    );
    expect(forgetBrowserSignIns).toHaveBeenCalledExactlyOnceWith(workspaceId);
    expect(alertOwner).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.stringContaining("1"),
      expect.anything()
    );
  });

  it("deletes the older profiles of a workspace that holds none now", async () => {
    readBrowserProfileId.mockResolvedValueOnce(undefined);
    listBrowserRunProfileIds.mockResolvedValueOnce([`vm:${workspaceId}:p1`]);
    const { forgetSignIns } = await import("@agent/lib/browser-use/sign-ins");

    expect(await forgetSignIns(scope, undefined)).toMatchObject({
      kind: "all",
    });
    expect(deleteBrowserUseProfile).toHaveBeenCalledExactlyOnceWith(
      `vm:${workspaceId}:p1`
    );
    expect(forgetBrowserProfile).not.toHaveBeenCalled();
  });

  it("waits while an errand still uses the profile", async () => {
    workspaceUsesBrowserProfile.mockResolvedValueOnce(true);
    const { forgetSignIns } = await import("@agent/lib/browser-use/sign-ins");

    expect(await forgetSignIns(scope, undefined)).toEqual({ kind: "busy" });
    expect(forgetBrowserProfile).not.toHaveBeenCalled();
    expect(deleteBrowserUseProfile).not.toHaveBeenCalled();
  });

  it("stops the visits to one site for good and leaves the profile alone", async () => {
    const { forgetSignIns } = await import("@agent/lib/browser-use/sign-ins");

    expect(await forgetSignIns(scope, "www.ozon.ru")).toEqual({
      kind: "site",
      site: "ozon.ru",
    });
    expect(stopBrowserSignInRefresh).toHaveBeenCalledExactlyOnceWith(
      workspaceId,
      "ozon.ru",
      expect.any(Date)
    );
    expect(forgetBrowserSignIns).not.toHaveBeenCalled();
    expect(deleteBrowserUseProfile).not.toHaveBeenCalled();
  });
});

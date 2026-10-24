import { beforeEach, describe, expect, it, vi } from "vitest";
import type { callInPageOverCdp } from "@agent/lib/browser-use/cdp";
import type { usesBrowserPool } from "@agent/lib/browser-vm/backend";
import type {
  createBrowserVmBrowser,
  renewBrowserVmExit,
  stopBrowserVmBrowser,
} from "@agent/lib/browser-vm/runs";

const browser = vi.hoisted(() => ({
  call: vi.fn<typeof callInPageOverCdp>(),
  open: vi.fn<typeof createBrowserVmBrowser>(),
  pool: vi.fn<typeof usesBrowserPool>(),
  renew: vi.fn<typeof renewBrowserVmExit>(),
  stop: vi.fn<typeof stopBrowserVmBrowser>(),
}));

vi.mock("@agent/lib/browser-use/cdp", () => ({
  PageUnreachableError: class PageUnreachableError extends Error {
    constructor(readonly ran: boolean) {
      super("The page could not reach its site.");
    }
  },
  callInPageOverCdp: browser.call,
}));
vi.mock("@agent/lib/browser-vm/backend", () => ({
  usesBrowserPool: browser.pool,
}));
vi.mock("@agent/lib/browser-vm/runs", () => ({
  createBrowserVmBrowser: browser.open,
  renewBrowserVmExit: browser.renew,
  stopBrowserVmBrowser: browser.stop,
}));

import { YclientsPageError, sendInPage } from "@agent/lib/yclients/page";

const request = { body: null, method: "GET" as const, path: "/api/v1/x" };
const landed = "https://api.yclients.com/robots.txt";

/** How the call ended, as the page tells it. */
const ran = (value: { status: number; text: string }[]) => ({
  ran: true as const,
  url: landed,
  value,
});

/** What sending threw. */
async function thrown(writes: boolean) {
  try {
    await sendInPage("workspace:alice", "token", [request], writes);
  } catch (error) {
    return error;
  }
  throw new Error("Expected a failure.");
}

beforeEach(() => {
  vi.clearAllMocks();
  browser.pool.mockResolvedValue(true);
  browser.open.mockResolvedValue({ cdpUrl: "ws://tab", id: "tab-1" });
  browser.renew.mockResolvedValue(true);
});

describe("YClients' calls from the person's browser", () => {
  it("answers each call's status and body, and closes the tab", async () => {
    browser.call.mockResolvedValueOnce(ran([{ status: 200, text: "{}" }]));

    expect(
      await sendInPage("workspace:alice", "token", [request], false)
    ).toEqual([{ status: 200, text: "{}" }]);
    expect(browser.stop).toHaveBeenCalledWith("tab-1");
  });

  it("checks the exit and reads again when not one call found a network", async () => {
    browser.call
      .mockResolvedValueOnce(ran([{ status: 0, text: "" }]))
      .mockResolvedValueOnce(ran([{ status: 200, text: "{}" }]));

    expect(
      await sendInPage("workspace:alice", "token", [request], false)
    ).toEqual([{ status: 200, text: "{}" }]);
    expect(browser.renew).toHaveBeenCalledTimes(1);
  });

  it("never sends a change again once it may have gone out", async () => {
    browser.call.mockResolvedValueOnce(ran([{ status: 0, text: "" }]));

    const error = await thrown(true);
    expect(error).toBeInstanceOf(YclientsPageError);
    expect(error).toMatchObject({ sent: true });
    expect(browser.renew).not.toHaveBeenCalled();
    expect(browser.call).toHaveBeenCalledTimes(1);
  });

  it("says nothing went out when the tab did not open or landed elsewhere", async () => {
    browser.open.mockRejectedValueOnce(new Error("no sandbox"));
    expect(await thrown(true)).toMatchObject({ sent: false });

    browser.call.mockResolvedValueOnce({
      ran: false,
      url: "https://yclients.com/403",
    });
    expect(await thrown(true)).toMatchObject({ sent: false });

    browser.pool.mockRejectedValueOnce(new Error("database"));
    expect(await thrown(true)).toMatchObject({ sent: false });
  });
});

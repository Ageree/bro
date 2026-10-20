import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Cdp from "@agent/lib/browser-use/cdp";
import type { usesBrowserPool } from "@agent/lib/browser-vm/backend";
import type {
  createBrowserVmBrowser,
  renewBrowserVmExit,
  stopBrowserVmBrowser,
} from "@agent/lib/browser-vm/runs";

const services = vi.hoisted(() => ({
  call: vi.fn<typeof Cdp.callInPageOverCdp>(),
  create: vi.fn<typeof createBrowserVmBrowser>(),
  pool: vi.fn<typeof usesBrowserPool>(),
  renew: vi.fn<typeof renewBrowserVmExit>(),
  stop: vi.fn<typeof stopBrowserVmBrowser>(),
}));

vi.mock("@agent/lib/browser-use/cdp", async (original) => ({
  ...(await original<typeof Cdp>()),
  callInPageOverCdp: services.call,
}));
vi.mock("@agent/lib/browser-vm/backend", () => ({
  usesBrowserPool: services.pool,
}));
vi.mock("@agent/lib/browser-vm/runs", () => ({
  createBrowserVmBrowser: services.create,
  renewBrowserVmExit: services.renew,
  stopBrowserVmBrowser: services.stop,
}));

import { z } from "zod";
import { PageUnreachableError } from "@agent/lib/browser-use/cdp";
import {
  type JsonValue,
  defineYandexOperation,
  operationArguments,
} from "@agent/lib/yandex/operations";
import { yandexOperations } from "@agent/lib/yandex/registry";
import { statusOperation } from "@agent/lib/yandex/status";
import { runYandexOperation } from "@agent/lib/yandex/transport";

const workspaceId = "workspace:alice";

function loaded(url: string, value?: JsonValue) {
  return { ran: true as const, url, value };
}

beforeEach(() => {
  vi.clearAllMocks();
  services.pool.mockResolvedValue(true);
  services.create.mockResolvedValue({ cdpUrl: "wss://pool/cdp", id: "tab-1" });
  services.renew.mockResolvedValue(true);
  services.stop.mockResolvedValue(undefined);
});

/** A cart change of Lavka's, which may not go out twice. */
const cartChange = defineYandexOperation({
  about: "Test cart change",
  access: "cart",
  args: z.object({}),
  id: "test.cart",
  origin: "https://lavka.yandex.ru/robots.txt",
  result: z.object({}),
  run: "async function () { return { status: 'ok', data: {} }; }",
  service: "yandex-lavka",
});

describe("a Yandex call the browser's exit did not carry", () => {
  const signedIn = loaded("https://id.yandex.ru/", {
    data: { requestWorks: true, signedIn: true },
    status: "ok",
  });

  it("moves the browser to another exit and reads again on it", async () => {
    // 20.10: the owner's sticky exit died, and every call failed on it.
    services.call
      .mockRejectedValueOnce(new PageUnreachableError(true))
      .mockResolvedValueOnce(signedIn);
    expect(await runYandexOperation(workspaceId, statusOperation, {})).toEqual({
      data: { requestWorks: true, signedIn: true },
      kind: "ok",
    });
    expect(services.renew).toHaveBeenCalledWith(
      services.create.mock.calls[0]?.[0].profileId
    );
    expect(services.call).toHaveBeenCalledTimes(2);
    expect(services.stop).toHaveBeenCalledTimes(2);
  });

  it("makes a change again only when nothing of it ran", async () => {
    services.call
      .mockResolvedValueOnce({
        ran: false,
        url: "chrome-error://chromewebdata/",
      })
      .mockResolvedValueOnce(
        loaded("https://lavka.yandex.ru/robots.txt", {
          data: {},
          status: "ok",
        })
      );
    expect(await runYandexOperation(workspaceId, cartChange, {})).toEqual({
      data: {},
      kind: "ok",
    });
    expect(services.call).toHaveBeenCalledTimes(2);

    services.call.mockReset();
    services.call.mockRejectedValue(new PageUnreachableError(true));
    expect(await runYandexOperation(workspaceId, cartChange, {})).toEqual({
      kind: "failed",
      reason: "page",
    });
    expect(services.renew).toHaveBeenCalledTimes(2);
    expect(services.call).toHaveBeenCalledTimes(1);
  });

  it("tries no more when no other exit could be had, or the new one fails too", async () => {
    services.renew.mockResolvedValueOnce(false);
    services.call.mockRejectedValue(new PageUnreachableError(false));
    expect(await runYandexOperation(workspaceId, statusOperation, {})).toEqual({
      kind: "failed",
      reason: "page",
    });
    expect(services.call).toHaveBeenCalledTimes(1);

    expect(await runYandexOperation(workspaceId, statusOperation, {})).toEqual({
      kind: "failed",
      reason: "page",
    });
    expect(services.call).toHaveBeenCalledTimes(3);
    expect(services.renew).toHaveBeenCalledTimes(2);
  });
});

describe("a Yandex call", () => {
  it("is never made for a workspace outside the pool", async () => {
    services.pool.mockResolvedValue(false);
    expect(await runYandexOperation(workspaceId, statusOperation, {})).toEqual({
      kind: "unavailable",
    });
    expect(services.create).not.toHaveBeenCalled();
  });

  it("wakes the sandbox, runs the fixed function with the arguments as data and closes the tab", async () => {
    services.call.mockResolvedValue(
      loaded("https://id.yandex.ru/", {
        data: { requestWorks: true, signedIn: true },
        status: "ok",
      })
    );
    const outcome = await runYandexOperation(workspaceId, statusOperation, {});
    expect(outcome).toEqual({
      data: { requestWorks: true, signedIn: true },
      kind: "ok",
    });
    expect(services.create.mock.calls[0]?.[0]).toMatchObject({ wake: true });
    const [cdpUrl, page] = services.call.mock.calls[0] ?? [];
    expect(cdpUrl).toBe("wss://pool/cdp");
    expect(page).toMatchObject({
      argument: {},
      fn: statusOperation.run,
      url: "https://id.yandex.ru/",
    });
    expect(page?.runOn("https://id.yandex.ru/")).toBe(true);
    expect(page?.runOn("https://evil.example/")).toBe(false);
    expect(services.stop).toHaveBeenCalledWith("tab-1");
  });

  it("uses distinct browser profiles for distinct workspaces", async () => {
    services.call.mockResolvedValue(
      loaded("https://id.yandex.ru/", {
        data: { requestWorks: true, signedIn: true },
        status: "ok",
      })
    );
    await runYandexOperation("workspace:alice", statusOperation, {});
    await runYandexOperation("workspace:bob", statusOperation, {});
    expect(services.create).toHaveBeenCalledTimes(2);
    const alice = services.create.mock.calls[0]?.[0].profileId;
    const bob = services.create.mock.calls[1]?.[0].profileId;
    expect(alice).toBeTruthy();
    expect(bob).toBeTruthy();
    expect(alice).not.toBe(bob);
  });

  it("reports the sign-in, a captcha and a stray redirect without running in them", async () => {
    services.call.mockResolvedValue({
      ran: false,
      url: "https://passport.yandex.ru/auth?retpath=x",
    });
    expect(await runYandexOperation(workspaceId, statusOperation, {})).toEqual({
      kind: "signed_out",
    });
    services.call.mockResolvedValue({
      ran: false,
      url: "https://market.yandex.ru/showcaptcha?x=1",
    });
    expect(await runYandexOperation(workspaceId, statusOperation, {})).toEqual({
      kind: "captcha",
    });
    services.call.mockResolvedValue({
      ran: false,
      url: "https://evil.example/",
    });
    expect(await runYandexOperation(workspaceId, statusOperation, {})).toEqual({
      kind: "failed",
      reason: "page",
    });
    expect(services.stop).toHaveBeenCalledTimes(3);
  });

  it("never submits a purchase on a different Yandex service origin", async () => {
    const operation = defineYandexOperation({
      about: "Test purchase",
      access: "purchase",
      args: z.object({}),
      id: "test.purchase",
      origin: "https://lavka.yandex.ru/",
      result: z.object({}),
      run: "async function () { return { status: 'ok', data: {} }; }",
      service: "yandex-lavka",
    });
    services.call.mockResolvedValue({
      ran: false,
      url: "https://market.yandex.ru/",
    });
    expect(await runYandexOperation(workspaceId, operation, {})).toEqual({
      kind: "failed",
      reason: "page",
    });
    const page = services.call.mock.calls[0]?.[1];
    expect(page?.runOn("https://lavka.yandex.ru/cart")).toBe(true);
    expect(page?.runOn("https://market.yandex.ru/cart")).toBe(false);
    expect(page?.runOn("https://lavka.yandex.ru:444/cart")).toBe(false);
    expect(page?.runOn("https://lavka.yandex.ru/showcaptcha")).toBe(false);
  });

  it("does not log private browser details when opening or closing fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      services.create.mockRejectedValueOnce(
        new Error("private-opening-detail")
      );
      await runYandexOperation(workspaceId, statusOperation, {});
      expect(warn).toHaveBeenLastCalledWith(
        "[yandex] the tab could not be opened",
        { name: "Error", operation: "status" }
      );
      services.call.mockResolvedValue(
        loaded("https://id.yandex.ru/", {
          data: { requestWorks: true, signedIn: true },
          status: "ok",
        })
      );
      services.stop.mockRejectedValueOnce(new Error("private-closing-detail"));
      await runYandexOperation(workspaceId, statusOperation, {});
      expect(warn).toHaveBeenLastCalledWith(
        "[yandex] the tab could not be closed",
        { name: "Error", operation: "status" }
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("takes the walls a function reports, and an answer that does not fit as a failure", async () => {
    services.call.mockResolvedValue(
      loaded("https://id.yandex.ru/", { status: "signed_out" })
    );
    expect(await runYandexOperation(workspaceId, statusOperation, {})).toEqual({
      kind: "signed_out",
    });
    services.call.mockResolvedValue(
      loaded("https://id.yandex.ru/", {
        data: { signedIn: false, token: "secret" },
        status: "ok",
      })
    );
    expect(await runYandexOperation(workspaceId, statusOperation, {})).toEqual({
      kind: "failed",
      reason: "answer",
    });
  });

  it("closes the tab and says nothing of the page when the call throws", async () => {
    services.call.mockRejectedValue(new Error("page text: password=hunter2"));
    const outcome = await runYandexOperation(workspaceId, statusOperation, {});
    expect(outcome).toEqual({ kind: "failed", reason: "page" });
    expect(services.stop).toHaveBeenCalledWith("tab-1");
  });
});

describe("the operations", () => {
  it("are all on Yandex's own sites, and read the arguments of their own shape", () => {
    for (const operation of yandexOperations) {
      expect(operation.origin).toMatch(/^https:\/\/[\w.-]*yandex\.ru\//u);
    }
    expect(
      operationArguments(statusOperation, { operation: "status" })
    ).toEqual({});
  });

  it("never read the browser's cookies", () => {
    for (const operation of yandexOperations) {
      expect(operation.run).not.toMatch(/cookie/iu);
    }
  });

  it("take no site but Yandex's own, and a cart change only with the attestation", () => {
    const spec = {
      about: "test",
      args: z.object({ id: z.string() }),
      id: "add",
      origin: "https://market.yandex.ru/",
      result: z.object({}),
      run: "async function () { return { status: 'ok', data: {} }; }",
      service: "market",
    } as const;
    expect(() =>
      defineYandexOperation({
        ...spec,
        access: "read",
        origin: "https://yandex.ru.evil.example/",
      })
    ).toThrow("not on a Yandex site");
    expect(() =>
      defineYandexOperation({
        ...spec,
        access: "read",
        origin: "http://market.yandex.ru/",
      })
    ).toThrow("not on a Yandex site");
    const cart = defineYandexOperation({ ...spec, access: "cart" });
    expect(cart.input.safeParse({ id: "1", operation: "add" }).success).toBe(
      false
    );
    expect(
      cart.input.safeParse({
        id: "1",
        operation: "add",
        personAskedToChangeCart: true,
      }).success
    ).toBe(true);
    const look = defineYandexOperation({ ...spec, access: "read" });
    expect(look.input.safeParse({ id: "1", operation: "add" }).success).toBe(
      true
    );
  });
});

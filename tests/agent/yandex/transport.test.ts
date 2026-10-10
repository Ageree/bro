import { beforeEach, describe, expect, it, vi } from "vitest";
import type { callInPageOverCdp } from "@agent/lib/browser-use/cdp";
import type { usesBrowserPool } from "@agent/lib/browser-vm/backend";
import type {
  createBrowserVmBrowser,
  stopBrowserVmBrowser,
} from "@agent/lib/browser-vm/runs";

const services = vi.hoisted(() => ({
  call: vi.fn<typeof callInPageOverCdp>(),
  create: vi.fn<typeof createBrowserVmBrowser>(),
  pool: vi.fn<typeof usesBrowserPool>(),
  stop: vi.fn<typeof stopBrowserVmBrowser>(),
}));

vi.mock("@agent/lib/browser-use/cdp", () => ({
  callInPageOverCdp: services.call,
}));
vi.mock("@agent/lib/browser-vm/backend", () => ({
  usesBrowserPool: services.pool,
}));
vi.mock("@agent/lib/browser-vm/runs", () => ({
  createBrowserVmBrowser: services.create,
  stopBrowserVmBrowser: services.stop,
}));

import { z } from "zod";
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
  services.stop.mockResolvedValue(undefined);
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

  it("is unavailable when the sandbox does not come up", async () => {
    services.create.mockRejectedValue(new Error("starting"));
    expect(await runYandexOperation(workspaceId, statusOperation, {})).toEqual({
      kind: "unavailable",
    });
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

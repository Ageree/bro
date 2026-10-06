import { afterEach, describe, expect, it, vi } from "vitest";
import type { readWorkspaceScope } from "@db/services/scope";
import type { readAccountEmail } from "@db/services/users";
import {
  browserVmTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

// The pilot names workspaces by id here: nothing is looked up.
vi.mock("@db/services/users", () => ({
  readAccountEmail: vi.fn<typeof readAccountEmail>(),
}));
vi.mock("@db/services/scope", () => ({
  readWorkspaceScope: vi.fn<typeof readWorkspaceScope>(),
}));

const workspaceId = "personal:0123456789abcdef0123456789abcdef";
const fallback =
  "gate.example.test:8080:login-country-ru-sid-{session}-ttl-24h:fb:pw";

afterEach(() => {
  clearBrowserVmSettings();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function loadProxy(line = browserVmTestEnvironment.BROWSER_VM_PROXY) {
  return importWithSettings(
    { BROWSER_VM_PROXY: line },
    async () => import("@agent/lib/browser-vm/proxy")
  );
}

describe("browser VM proxy", () => {
  it("keeps one sticky session per workspace, and another on each rotation", async () => {
    const proxy = await loadProxy();

    expect(proxy.browserVmProxySession(workspaceId)).toBe("bro1e09f74980c7");
    expect(proxy.browserVmProxySession(workspaceId, 2)).toBe(
      "bro1e09f74980c7r2"
    );
    expect(proxy.browserVmProxySession("ws_test_123")).toBe("bro251826550eba");
  });

  it("puts the session into the username and keeps a password with colons whole", async () => {
    const proxy = await loadProxy();

    expect(proxy.browserVmProxy("bro1e09f74980c7")).toEqual({
      host: "proxy.example.test",
      password: "pa:ss",
      port: 9000,
      username: "user-session-bro1e09f74980c7",
    });
  });

  it("refuses a session token the provider's username syntax may not take", async () => {
    const proxy = await loadProxy();

    expect(() => proxy.browserVmProxy("bro-1")).toThrow("letters and digits");
  });

  it("is not configured without the setting", async () => {
    const proxy = await importWithSettings(
      {},
      async () => import("@agent/lib/browser-vm/proxy")
    );

    expect(() => proxy.browserVmProxy("bro1")).toThrow(
      "BROWSER_VM_PROXY is not configured."
    );
  });

  // One exit for every workspace would let a site tie their sign-ins together.
  it("is refused at startup without a session placeholder or a port", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      loadProxy("proxy.example.test:9000:user:pass")
    ).rejects.toThrow("Invalid environment variables");
    await expect(
      loadProxy("proxy.example.test:port:user-{session}:pass")
    ).rejects.toThrow("Invalid environment variables");
    await expect(
      importWithSettings(
        {
          ...browserVmTestEnvironment,
          BROWSER_VM_PROXY_FALLBACK: "gate.example.test:8080:login:pw",
        },
        async () => import("@agent/lib/browser-vm/proxy")
      )
    ).rejects.toThrow("Invalid environment variables");
  });
});

describe("the second proxy", () => {
  it("is not there without the fallback, whatever the pilot says", async () => {
    const proxy = await importWithSettings(
      {
        ...browserVmTestEnvironment,
        BROWSER_PROXY_FALLBACK_FIRST_WORKSPACES: "*",
      },
      async () => import("@agent/lib/browser-vm/proxy")
    );

    expect(await proxy.browserVmProxyLines({ workspaceId })).toEqual([
      "BROWSER_VM_PROXY",
    ]);
    // A session stored on a second proxy since dropped starts over.
    expect(
      proxy.browserVmProxyPlace("bro1e09f74980c7s2", ["BROWSER_VM_PROXY"])
    ).toEqual({ line: "BROWSER_VM_PROXY", rotation: 0 });
    expect(() =>
      proxy.browserVmProxy("bro1e09f74980c7s0", "BROWSER_VM_PROXY_FALLBACK")
    ).toThrow("BROWSER_VM_PROXY_FALLBACK is not configured.");
  });

  it("comes after the first, or before it for a workspace of the pilot", async () => {
    const proxy = await importWithSettings(
      {
        ...browserVmTestEnvironment,
        BROWSER_PROXY_FALLBACK_FIRST_WORKSPACES: `personal:another, ${workspaceId}`,
        BROWSER_VM_PROXY_FALLBACK: fallback,
      },
      async () => import("@agent/lib/browser-vm/proxy")
    );

    expect(
      await proxy.browserVmProxyLines({ workspaceId: "personal:third" })
    ).toEqual(["BROWSER_VM_PROXY", "BROWSER_VM_PROXY_FALLBACK"]);
    expect(await proxy.browserVmProxyLines({ workspaceId })).toEqual([
      "BROWSER_VM_PROXY_FALLBACK",
      "BROWSER_VM_PROXY",
    ]);
  });

  it("has sessions of its own, and the stored one says which proxy it is on", async () => {
    const proxy = await importWithSettings(
      { ...browserVmTestEnvironment, BROWSER_VM_PROXY_FALLBACK: fallback },
      async () => import("@agent/lib/browser-vm/proxy")
    );
    const order = ["BROWSER_VM_PROXY", "BROWSER_VM_PROXY_FALLBACK"] as const;
    const pilot = ["BROWSER_VM_PROXY_FALLBACK", "BROWSER_VM_PROXY"] as const;

    expect(proxy.browserVmProxySession(workspaceId, 0, true)).toBe(
      "bro1e09f74980c7s0"
    );
    expect(proxy.browserVmProxySession(workspaceId, 2, true)).toBe(
      "bro1e09f74980c7s2"
    );
    expect(proxy.browserVmProxyPlace(null, order)).toEqual({
      line: "BROWSER_VM_PROXY",
      rotation: 0,
    });
    expect(proxy.browserVmProxyPlace("bro1e09f74980c7r3", order)).toEqual({
      line: "BROWSER_VM_PROXY",
      rotation: 3,
    });
    expect(proxy.browserVmProxyPlace("bro1e09f74980c7s2", order)).toEqual({
      line: "BROWSER_VM_PROXY_FALLBACK",
      rotation: 2,
    });
    // The pilot's order has the fallback first, on the same sessions.
    expect(proxy.browserVmProxyPlace("bro1e09f74980c7r3", pilot)).toEqual({
      line: "BROWSER_VM_PROXY_FALLBACK",
      rotation: 3,
    });
    expect(proxy.browserVmProxyPlace("bro1e09f74980c7s0", pilot)).toEqual({
      line: "BROWSER_VM_PROXY",
      rotation: 0,
    });
    expect(
      proxy.browserVmProxy("bro1e09f74980c7s0", "BROWSER_VM_PROXY_FALLBACK")
    ).toEqual({
      host: "gate.example.test",
      password: "fb:pw",
      port: 8080,
      username: "login-country-ru-sid-bro1e09f74980c7s0-ttl-24h",
    });
  });
});

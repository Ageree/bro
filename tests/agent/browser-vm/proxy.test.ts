import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserVmTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

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
  });
});

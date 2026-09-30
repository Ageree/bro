import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserPoolTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

afterEach(() => {
  clearBrowserVmSettings();
  vi.resetModules();
});

async function loadKeys(settings = {}) {
  return importWithSettings(
    { ...browserPoolTestEnvironment, ...settings },
    async () => import("@agent/lib/browser-pool/keys")
  );
}

describe("browser pool keys", () => {
  // Computed with Python's `cryptography` HKDF (no salt, the workspace id as
  // info) from BROWSER_STATE_KEY "22" × 32: a change here makes every
  // parked set unreadable.
  it("derive a workspace's data key with HKDF, the same every time", async () => {
    const keys = await loadKeys();

    expect(keys.browserStateDataKey(workspaceId)).toBe(
      "a0be5fd00e609e63426183b7f252b7e7c41752a205386060f52f7c985a67fa48"
    );
    expect(keys.browserStateDataKey(workspaceId)).toBe(
      keys.browserStateDataKey(workspaceId)
    );
    expect(keys.browserStateDataKey("personal:else")).not.toBe(
      keys.browserStateDataKey(workspaceId)
    );
    const rotated = await loadKeys({ BROWSER_STATE_KEY: "33".repeat(32) });
    expect(rotated.browserStateDataKey(workspaceId)).not.toBe(
      "a0be5fd00e609e63426183b7f252b7e7c41752a205386060f52f7c985a67fa48"
    );
  });

  // The key `browser-vm/host/test_hostd.py` pins for `host-test-1`, and
  // `host_key` of `boot.py` writes into a host's cloud-init.
  it("derive a host's token key as hostd and boot.py do", async () => {
    const keys = await loadKeys();

    expect(keys.browserHostKey("host-test-1").toString("hex")).toBe(
      "fc0873b32715053d3ff2f84210fe16de8ecebea4b2ea502271c9d927192c9620"
    );
    expect(keys.browserHostKey("bro-host-1").toString("hex")).toBe(
      "5e0ea55ff2228191fa2228ec2be4772ae5996067b39209c4e56c51fda74c9d03"
    );
  });

  it("name a workspace's sandbox with what hostd accepts", async () => {
    const keys = await loadKeys();
    const id = keys.browserSandboxId(workspaceId);

    expect(id).toBe("ws-1e09f74980c731c7119e14ac3afe57dbe608baba");
    expect(id).toMatch(/^[a-z\d-]{1,63}$/u);
    expect(keys.browserSandboxId("personal:else")).not.toBe(id);
  });

  it("refuse without the keys they derive from", async () => {
    const keys = await loadKeys({
      BROWSER_STATE_KEY: "",
      BROWSER_VM_SIGNING_KEY: "",
    });

    expect(() => keys.browserStateDataKey(workspaceId)).toThrow(
      "BROWSER_STATE_KEY"
    );
    expect(() => keys.browserHostKey("bro-host-1")).toThrow(
      "BROWSER_VM_SIGNING_KEY"
    );
  });
});

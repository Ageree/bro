import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

// The vector `browser-vm/worker/test_worker.py` checks on the worker's side:
// both sides must sign and verify the very same bytes.
const signingKey = "11".repeat(32);
const workspaceId = "ws_test_123";
const vmKeyHex =
  "b62a60b9925024534507acf039e236b698c33866d8e18c727661251748984301";
const issuedAtSeconds = 1_790_000_000;

afterEach(() => {
  clearBrowserVmSettings();
  vi.useRealTimers();
  vi.resetModules();
});

async function loadToken(key = signingKey) {
  return importWithSettings(
    { BROWSER_VM_SIGNING_KEY: key },
    async () => import("@agent/lib/browser-vm/token")
  );
}

describe("browser VM tokens", () => {
  it("derive each VM's key from the signing key and the workspace", async () => {
    const token = await loadToken();

    expect(token.browserVmKey(workspaceId).toString("hex")).toBe(vmKeyHex);
    expect(token.browserVmKey("ws_other").toString("hex")).not.toBe(vmKeyHex);
  });

  it("sign the payload the worker verifies, byte for byte", async () => {
    const token = await loadToken();
    vi.useFakeTimers();
    vi.setSystemTime(issuedAtSeconds * 1_000);

    expect(token.signBrowserVmToken({ generation: 3, workspaceId })).toBe(
      "v1.eyJlbnYiOiJ3c190ZXN0XzEyMyIsImdlbiI6MywiZXhwIjoxNzkwMDAwMzAwfQ.sounRHPylHeCoYxmM2jPawS3Bh0zE45yyIKv54MsuL8"
    );
    expect(
      token.signBrowserVmToken({
        generation: 3,
        session: "vm:ws_test_123:s:abc",
        workspaceId,
      })
    ).toBe(
      "v1.eyJlbnYiOiJ3c190ZXN0XzEyMyIsImdlbiI6MywiZXhwIjoxNzkwMDAwMzAwLCJzZXMiOiJ2bTp3c190ZXN0XzEyMzpzOmFiYyJ9.BXSmPnEMmg0KrJrCg1FDFLgyF6EQ0qXdjHeIe7oPMbY"
    );
  });

  // The worker refuses a token valid for more than fifteen minutes.
  it("never live longer than the worker accepts", async () => {
    const token = await loadToken();

    expect(() =>
      token.signBrowserVmToken({ generation: 1, ttlSeconds: 901, workspaceId })
    ).toThrow("1 to 900 seconds");
    expect(() =>
      token.signBrowserVmToken({ generation: 1, ttlSeconds: 0, workspaceId })
    ).toThrow("1 to 900 seconds");
  });

  it("are not signed without a signing key", async () => {
    const token = await importWithSettings(
      {},
      async () => import("@agent/lib/browser-vm/token")
    );

    expect(() =>
      token.signBrowserVmToken({ generation: 1, workspaceId })
    ).toThrow("BROWSER_VM_SIGNING_KEY is not configured.");
  });
});

describe("browser VM cloud-init", () => {
  it("hands the worker its environment and key, readable by the worker alone", async () => {
    const token = await loadToken();

    expect(token.browserVmCloudInit({ workspaceId })).toBe(
      [
        "#cloud-config",
        "write_files:",
        "  - path: /etc/bro/worker.json",
        "    owner: bro:bro",
        '    permissions: "0600"',
        `    content: '{"environment":"ws_test_123","key":"${vmKeyHex}"}'`,
        "runcmd:",
        "  - [systemctl, restart, bro-worker]",
        "",
      ].join("\n")
    );
  });
});

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

afterEach(() => {
  clearSandboxSettings();
  vi.resetModules();
});

const keys = async () =>
  await importWithSandbox(async () => await import("@agent/lib/sandbox/keys"));

describe("sandbox host tokens", () => {
  it("signs hostd's format with the host's derived key", async () => {
    const { sandboxHostKey, signSandboxHostToken } = await keys();
    const token = signSandboxHostToken("sbx-code-1", 300, 1_790_000_000_000);
    const [version, body, signature] = token.split(".");
    expect(version).toBe("v1");
    expect(Buffer.from(body ?? "", "base64url").toString()).toBe(
      '{"env":"sbx-code-1","exp":1790000300}'
    );
    expect(signature).toBe(
      createHmac("sha256", sandboxHostKey("sbx-code-1"))
        .update(`v1.${body ?? ""}`)
        .digest("base64url")
    );
    expect(sandboxHostKey("sbx-code-1")).toEqual(
      createHmac("sha256", Buffer.from("33".repeat(32), "hex"))
        .update("bro-sandbox-host:sbx-code-1")
        .digest()
    );
  });

  it("refuses a token sandboxd would not take", async () => {
    const { signSandboxHostToken } = await keys();
    expect(() => signSandboxHostToken("sbx-code-1", 901)).toThrow(
      "1 second to 15 minutes"
    );
    expect(() => signSandboxHostToken("sbx-code-1", 0)).toThrow(
      "1 second to 15 minutes"
    );
  });
});

describe("tool router tokens", () => {
  const now = 1_790_000_000_000;

  it("opens the router for its sandbox and workspace until it expires", async () => {
    const { signSandboxToolsToken, verifySandboxToolsToken } = await keys();
    const token = signSandboxToolsToken({
      now,
      sandboxId: "sb-1",
      ttlSeconds: 60,
      workspaceId: "personal:abc",
    });
    expect(verifySandboxToolsToken(token, now)).toEqual({
      exp: 1_790_000_060,
      sb: "sb-1",
      ws: "personal:abc",
    });
    expect(verifySandboxToolsToken(token, now + 61_000)).toBeUndefined();
  });

  it("reads a tampered or foreign token as no token", async () => {
    const { signSandboxToolsToken, verifySandboxToolsToken } = await keys();
    const token = signSandboxToolsToken({
      now,
      sandboxId: "sb-1",
      workspaceId: "personal:abc",
    });
    const [version, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sb: "sb-2", ws: "personal:abc", exp: 1_790_000_060 })
    ).toString("base64url");
    expect(
      verifySandboxToolsToken(
        `${version ?? ""}.${forged}.${signature ?? ""}`,
        now
      )
    ).toBeUndefined();
    expect(verifySandboxToolsToken("v1.e30", now)).toBeUndefined();
    expect(verifySandboxToolsToken("nonsense", now)).toBeUndefined();
  });
});

describe("sandbox names", () => {
  it("names a session's sandbox the way sandboxd accepts", async () => {
    const { sandboxIdFor, sandboxSnapshotKey } = await keys();
    const id = sandboxIdFor("session:abc/task:1");
    expect(id).toMatch(/^sb-[\da-f]{40}$/u);
    expect(sandboxIdFor("session:abc/task:1")).toBe(id);
    expect(sandboxSnapshotKey(id)).toMatch(/^[\da-f]{64}$/u);
    expect(sandboxSnapshotKey(id)).not.toBe(sandboxSnapshotKey(`${id}0`));
  });
});

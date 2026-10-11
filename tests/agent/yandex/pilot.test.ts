import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.stubEnv("YANDEX_API_WORKSPACES", "");
  vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "");
  vi.resetModules();
});

async function enabled(
  api: string,
  purchases: string,
  workspaceId = "workspace:alice"
) {
  vi.resetModules();
  vi.stubEnv("YANDEX_API_WORKSPACES", api);
  vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", purchases);
  const { yandexPurchasePilot } = await import("@agent/lib/yandex/pilot");
  return yandexPurchasePilot({ workspaceId });
}

describe("the separate Yandex purchase pilot", () => {
  it("stays off unless both pilots include the workspace", async () => {
    expect(await enabled("*", "")).toBe(false);
    expect(await enabled("", "*")).toBe(false);
    expect(await enabled("workspace:alice", "workspace:bob")).toBe(false);
    expect(await enabled("workspace:alice", "workspace:alice")).toBe(true);
  });

  it("allows explicit workspace ids and the all-workspaces switch", async () => {
    expect(await enabled("*", "workspace:alice")).toBe(true);
    expect(await enabled("workspace:alice", "*")).toBe(true);
    expect(await enabled("*", "workspace:alice", "workspace:bob")).toBe(false);
  });
});

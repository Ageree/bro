import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceId = "workspace:alice";

afterEach(() => {
  vi.stubEnv("SUBSCRIPTIONS_WORKSPACES", "");
});

async function pilot(list: string) {
  vi.resetModules();
  vi.stubEnv("SUBSCRIPTIONS_WORKSPACES", list);
  const { subscriptionsPilot } = await import("@agent/lib/subscriptions/pilot");
  return subscriptionsPilot({ workspaceId });
}

describe("the pilot of event subscriptions", () => {
  it("names nobody while unset, a listed workspace, or everyone with *", async () => {
    expect(await pilot("")).toBe(false);
    expect(await pilot("workspace:bob")).toBe(false);
    expect(await pilot(`workspace:bob, ${workspaceId}`)).toBe(true);
    expect(await pilot("*")).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceId = "workspace:alice";

afterEach(() => {
  vi.stubEnv("AGENCY_WORKSPACES", "");
});

async function pilot(list: string) {
  vi.resetModules();
  vi.stubEnv("AGENCY_WORKSPACES", list);
  const { agencyPilot } = await import("@agent/lib/agency/pilot");
  return agencyPilot(workspaceId);
}

describe("the pilot of the agentic worker", () => {
  it("names nobody while unset, a listed workspace only by id, or everyone with *", async () => {
    expect(await pilot("")).toBe(false);
    expect(await pilot("workspace:bob")).toBe(false);
    expect(await pilot(`workspace:bob, ${workspaceId}`)).toBe(true);
    expect(await pilot("*")).toBe(true);
  });

  it("refuses an owner's email, which would need a lookup", async () => {
    vi.resetModules();
    vi.stubEnv("AGENCY_WORKSPACES", "alice@example.com");
    await expect(import("@agent/lib/agency/pilot")).rejects.toThrow(
      "Invalid environment variables"
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceId = "workspace:alice";

afterEach(() => {
  vi.stubEnv("AGENCY_WORKSPACES", "");
  vi.stubEnv("AGENCY_LIMITS", "");
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

  it("lifts the limits only for the pilot, and only when told to", async () => {
    const run = async (workspaces: string, limits: string) => {
      vi.resetModules();
      vi.stubEnv("AGENCY_WORKSPACES", workspaces);
      vi.stubEnv("AGENCY_LIMITS", limits);
      const { agencyLimited, proactiveRunCap } =
        await import("@agent/lib/agency/pilot");
      return [agencyLimited(workspaceId), proactiveRunCap(workspaceId, 30)];
    };
    expect(await run("*", "")).toEqual([true, 30]);
    expect(await run("*", "on")).toEqual([true, 30]);
    expect(await run("*", "off")).toEqual([false, Number.MAX_SAFE_INTEGER]);
    // Outside the pilot the flag changes nothing.
    expect(await run("workspace:bob", "off")).toEqual([true, 30]);
  });
});

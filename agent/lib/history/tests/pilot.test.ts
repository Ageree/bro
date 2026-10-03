import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

// Unstubbing every variable would drop the setup of `tests/setup-env.ts`.
afterEach(() => {
  vi.stubEnv("HISTORY_TRIM_WORKSPACES", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
});

async function pilot(list: string, settings: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("HISTORY_TRIM_WORKSPACES", list);
  for (const [name, value] of Object.entries(settings)) {
    vi.stubEnv(name, value);
  }
  const { historyTrimPilot } = await import("@agent/lib/history/pilot");
  return historyTrimPilot({ workspaceId });
}

const openRouter = { OPENROUTER_API_KEY: "openrouter-test-key" };
const gateway = { OPENROUTER_API_KEY: "" };

describe("the pilot list of trimming old history", () => {
  it("names nobody while unset, and nobody on the Gateway", async () => {
    expect(await pilot("", openRouter)).toBe(false);
    expect(await pilot("*", gateway)).toBe(false);
    expect(await pilot(workspaceId, gateway)).toBe(false);
  });

  it("names a workspace by id, or everyone by *", async () => {
    expect(await pilot("*", openRouter)).toBe(true);
    expect(await pilot(` other , ${workspaceId} `, openRouter)).toBe(true);
    expect(await pilot("other", openRouter)).toBe(false);
  });
});

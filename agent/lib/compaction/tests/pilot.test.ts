import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

// Unstubbing every variable would drop the setup of `tests/setup-env.ts`.
afterEach(() => {
  vi.stubEnv("COMPACTION_INPUT_TOKENS", "");
  vi.stubEnv("COMPACTION_WORKSPACES", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.restoreAllMocks();
});

async function pilot(list: string, settings: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("COMPACTION_WORKSPACES", list);
  for (const [name, value] of Object.entries(settings)) {
    vi.stubEnv(name, value);
  }
  const { compactionPilot } = await import("@agent/lib/compaction/pilot");
  return compactionPilot({ workspaceId });
}

const openRouter = { OPENROUTER_API_KEY: "openrouter-test-key" };
const gateway = { OPENROUTER_API_KEY: "" };

describe("the pilot list of compaction", () => {
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

describe("the input a pilot step compacts at", () => {
  it("is 150k unless set, and never below 100k", async () => {
    vi.resetModules();
    const { env } = await import("@shared/environment");
    expect(env.COMPACTION_INPUT_TOKENS).toBe(150_000);

    vi.resetModules();
    vi.stubEnv("COMPACTION_INPUT_TOKENS", "99999");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(import("@shared/environment")).rejects.toThrow(
      "Invalid environment variables"
    );
  });
});

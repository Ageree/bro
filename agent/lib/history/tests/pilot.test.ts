import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { readWorkspaceScope } from "@db/services/scope";
import type { readAccountEmail } from "@db/services/users";

const services = vi.hoisted(() => ({
  readAccountEmail: vi.fn<typeof readAccountEmail>(),
  readWorkspaceScope: vi.fn<typeof readWorkspaceScope>(),
}));

vi.mock("@db/services/users", () => ({
  readAccountEmail: services.readAccountEmail,
}));
vi.mock("@db/services/scope", () => ({
  readWorkspaceScope: services.readWorkspaceScope,
}));

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

beforeEach(() => {
  vi.clearAllMocks();
  services.readAccountEmail.mockResolvedValue("Alice@Example.com");
  services.readWorkspaceScope.mockResolvedValue({
    userId: "user-1",
    workspaceId,
  });
});

// Unstubbing every variable would drop the setup of `tests/setup-env.ts`.
afterEach(() => {
  vi.stubEnv("HISTORY_TRIM_WORKSPACES", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
});

async function loadPilot(list: string, settings: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("HISTORY_TRIM_WORKSPACES", list);
  for (const [name, value] of Object.entries(settings)) {
    vi.stubEnv(name, value);
  }
  const { historyTrimPilot } = await import("@agent/lib/history/pilot");
  return historyTrimPilot;
}

async function pilot(list: string, settings: Record<string, string>) {
  return (await loadPilot(list, settings))({ workspaceId });
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

  it("names a workspace by its owner's email, whatever its case", async () => {
    expect(await pilot("alice@example.com", openRouter)).toBe(true);
    expect(await pilot("bob@example.com", openRouter)).toBe(false);
  });

  it("keeps a failed email lookup out of the pilot", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    services.readAccountEmail.mockRejectedValue(new Error("db down"));

    expect(await pilot("alice@example.com", openRouter)).toBe(false);
  });

  it("holds the verdict for the whole turn", async () => {
    const historyTrimPilot = await loadPilot("alice@example.com", openRouter);
    const turn = { sessionId: "session-memo", turnId: "turn_19" };

    expect(await historyTrimPilot({ workspaceId }, turn)).toBe(true);
    // A failed lookup at a later step of the turn changes nothing.
    services.readAccountEmail.mockRejectedValue(new Error("db down"));
    expect(await historyTrimPilot({ workspaceId }, turn)).toBe(true);
    expect(services.readAccountEmail).toHaveBeenCalledOnce();
  });
});

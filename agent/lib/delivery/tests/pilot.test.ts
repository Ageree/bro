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
  vi.restoreAllMocks();
  vi.stubEnv("EARLY_REPLY_WORKSPACES", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
});

async function loadPilot(list: string, settings: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("EARLY_REPLY_WORKSPACES", list);
  for (const [name, value] of Object.entries(settings)) {
    vi.stubEnv(name, value);
  }
  return import("@agent/lib/delivery/pilot");
}

async function pilot(list: string, settings: Record<string, string>) {
  const { earlyReplyPilot } = await loadPilot(list, settings);
  return earlyReplyPilot({ workspaceId });
}

const openRouter = { OPENROUTER_API_KEY: "openrouter-test-key" };
const gateway = { OPENROUTER_API_KEY: "" };

/** A `step.started` resolver's context for a person of the workspace. */
function callerContext(principalType: "service" | "user") {
  return {
    session: {
      auth: {
        current: {
          attributes: { workspaceId },
          authenticator: "telegram",
          principalId: "user-1",
          principalType,
        },
        initiator: null,
      },
      id: "session-1",
    },
  } as const;
}

describe("the pilot list of the early reply", () => {
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

  it("gives send_message the verdict the model's resolver got for the turn", async () => {
    const { earlyReplyPilot, earlyReplyPilotOfCaller } = await loadPilot(
      "alice@example.com",
      openRouter
    );
    const event = { data: { stepIndex: 0, turnId: "turn_4" } };
    const turn = { sessionId: "session-1", turnId: "turn_4" };

    expect(await earlyReplyPilot({ workspaceId }, turn)).toBe(true);
    services.readAccountEmail.mockRejectedValue(new Error("db down"));
    expect(await earlyReplyPilotOfCaller(callerContext("user"), event)).toBe(
      true
    );
    expect(services.readAccountEmail).toHaveBeenCalledOnce();
  });

  it("leaves out a caller that is no workspace user, and asks nothing unset", async () => {
    const event = { data: { stepIndex: 0, turnId: "turn_0" } };
    const listed = await loadPilot("*", openRouter);

    expect(
      await listed.earlyReplyPilotOfCaller(callerContext("service"), event)
    ).toBe(false);
    const unset = await loadPilot("", openRouter);
    expect(
      await unset.earlyReplyPilotOfCaller(callerContext("user"), event)
    ).toBe(false);
    expect(services.readAccountEmail).not.toHaveBeenCalled();
  });
});

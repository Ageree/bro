import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { readWorkspaceScope } from "@db/services/scope";
import type { ModelMessage } from "ai";
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
  vi.stubEnv("FAST_REPLY_WORKSPACES", "");
  vi.stubEnv("FAST_FIRST_STEP_WORKSPACES", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
});

async function loadPilot(list: string, settings: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("FAST_REPLY_WORKSPACES", list);
  for (const [name, value] of Object.entries(settings)) {
    vi.stubEnv(name, value);
  }
  const { fastReplyPilot } = await import("@agent/lib/delivery/fast");
  return fastReplyPilot;
}

async function pilot(list: string, settings: Record<string, string>) {
  return (await loadPilot(list, settings))({ workspaceId });
}

const openRouter = { OPENROUTER_API_KEY: "openrouter-test-key" };
const gateway = { OPENROUTER_API_KEY: "" };

describe("the pilot list of fast answer steps", () => {
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
    const fastReplyPilot = await loadPilot("alice@example.com", openRouter);
    const turn = { sessionId: "session-memo", turnId: "turn_19" };

    expect(await fastReplyPilot({ workspaceId }, turn)).toBe(true);
    // A failed lookup at a later step of the turn changes nothing.
    services.readAccountEmail.mockRejectedValue(new Error("db down"));
    expect(await fastReplyPilot({ workspaceId }, turn)).toBe(true);
    expect(services.readAccountEmail).toHaveBeenCalledOnce();
  });
});

describe("the pilot list of the first step", () => {
  it("is a list of its own", async () => {
    vi.resetModules();
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("FAST_REPLY_WORKSPACES", "*");
    vi.stubEnv("FAST_FIRST_STEP_WORKSPACES", "other");
    const { fastFirstStepPilot, fastReplyPilot } =
      await import("@agent/lib/delivery/fast");
    expect(await fastReplyPilot({ workspaceId })).toBe(true);
    expect(await fastFirstStepPilot({ workspaceId })).toBe(false);
  });
});

describe("the step that relays a tool result", () => {
  const user: ModelMessage = { content: "Который час?", role: "user" };
  const call: ModelMessage = {
    content: [
      { input: {}, toolCallId: "c1", toolName: "clock", type: "tool-call" },
    ],
    role: "assistant",
  };
  const result: ModelMessage = {
    content: [
      {
        output: { type: "text", value: "12:00" },
        toolCallId: "c1",
        toolName: "clock",
        type: "tool-result",
      },
    ],
    role: "tool",
  };

  it("is a step after a result of the turn, not the first", async () => {
    vi.stubEnv("FAST_REPLY_WORKSPACES", "*");
    const { relaysToolResult } = await import("@agent/lib/delivery/fast");
    expect(relaysToolResult([user])).toBe(false);
    expect(relaysToolResult([user, call, result])).toBe(true);
  });

  it("ignores results of earlier turns", async () => {
    const { relaysToolResult } = await import("@agent/lib/delivery/fast");
    expect(relaysToolResult([user, call, result, user])).toBe(false);
  });
});

describe("the pilot list of the split heads-up", () => {
  it("is a list of its own", async () => {
    vi.resetModules();
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("EARLY_REPLY_SPLIT_WORKSPACES", workspaceId);
    const { earlyReplySplitPilot } = await import("@agent/lib/delivery/fast");
    expect(await earlyReplySplitPilot({ workspaceId })).toBe(true);
    expect(await earlyReplySplitPilot({ workspaceId: "other" })).toBe(false);
    vi.stubEnv("EARLY_REPLY_SPLIT_WORKSPACES", "");
  });
});

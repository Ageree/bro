import { afterEach, describe, expect, it, vi } from "vitest";
import type { readWorkspaceScope } from "@db/services/scope";
import type { readAccountEmail } from "@db/services/users";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

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

afterEach(() => {
  clearSandboxSettings();
  vi.clearAllMocks();
  vi.resetModules();
});

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

describe("the task agent's pilot", () => {
  it("looks the owner's email up once for many steps, and keeps a failed lookup out", async () => {
    services.readAccountEmail.mockResolvedValue("Alice@Example.com");
    services.readAccountEmail.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { taskAgentPilot } = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/pilot"),
      {
        OPENROUTER_API_KEY: "openrouter-test-key",
        SANDBOX_WORKSPACES: "alice@example.com",
      }
    );

    const scope = { userId: "user-1", workspaceId };
    expect(await taskAgentPilot(scope)).toBe(false);
    expect(await taskAgentPilot(scope)).toBe(true);
    expect(await taskAgentPilot(scope)).toBe(true);
    expect(await taskAgentPilot(scope)).toBe(true);
    expect(services.readAccountEmail).toHaveBeenCalledTimes(2);
  });

  it("names nobody on the Gateway, whatever the list says", async () => {
    const { taskAgentPilot } = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/pilot"),
      { SANDBOX_WORKSPACES: "*" }
    );
    expect(await taskAgentPilot({ workspaceId })).toBe(false);
  });
});

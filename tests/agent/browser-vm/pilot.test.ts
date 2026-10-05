import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.stubEnv("BROWSER_FAST_WORKSPACES", "");
  vi.clearAllMocks();
  vi.resetModules();
});

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

async function loadPilot(list: string) {
  vi.resetModules();
  vi.stubEnv("BROWSER_FAST_WORKSPACES", list);
  return import("@agent/lib/browser-vm/pilot");
}

describe("the fast browser's pilot", () => {
  it("names nobody while unset, a listed workspace, or everyone with *, asking nobody", async () => {
    expect(await (await loadPilot("")).fastBrowserPilot({ workspaceId })).toBe(
      false
    );
    expect(
      await (
        await loadPilot("personal:another")
      ).fastBrowserPilot({ workspaceId })
    ).toBe(false);
    expect(
      await (
        await loadPilot(`personal:another, ${workspaceId}`)
      ).fastBrowserPilot({ workspaceId })
    ).toBe(true);
    expect(await (await loadPilot("*")).fastBrowserPilot({ workspaceId })).toBe(
      true
    );
    expect(services.readAccountEmail).not.toHaveBeenCalled();
  });

  it("runs an errand as before when the owner's email cannot be looked up, and looks a found one up once", async () => {
    services.readAccountEmail.mockResolvedValue("Alice@Example.com");
    services.readAccountEmail.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { fastBrowserPilot } = await loadPilot("alice@example.com");

    const scope = { userId: "user-1", workspaceId };
    expect(await fastBrowserPilot(scope)).toBe(false);
    expect(await fastBrowserPilot(scope)).toBe(true);
    expect(await fastBrowserPilot(scope)).toBe(true);
    expect(services.readAccountEmail).toHaveBeenCalledTimes(2);
  });
});

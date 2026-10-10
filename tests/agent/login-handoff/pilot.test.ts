import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@agent/lib/workspace-list", () => ({
  listsWorkspaceRemembered: (
    list: readonly string[],
    scope: { workspaceId: string }
  ) => Promise.resolve(list.includes(scope.workspaceId)),
}));
vi.mock("@shared/agent-mail/api", () => ({
  createAgentMailInbox: vi.fn<() => void>(),
}));
vi.mock("@db/services/agent-mailboxes", () => ({
  readAgentMailbox: vi.fn<() => void>(),
  saveAgentMailbox: vi.fn<() => void>(),
}));

afterEach(() => {
  // The setup file stubs the rest of the environment: only these are undone.
  for (const name of [
    "AGENTMAIL_API_KEY",
    "AGENTMAIL_WORKSPACES",
    "LOGIN_HANDOFF_WORKSPACES",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.resetModules();
});

async function pilot() {
  return import("@agent/lib/login-handoff/pilot");
}

describe("the sign-in link switch", () => {
  it("is on for every workspace while the flag is unset or empty", async () => {
    const { loginHandoffOn, loginHandoffPilot } = await pilot();
    expect(loginHandoffOn()).toBe(true);
    await expect(loginHandoffPilot({ workspaceId: "w-1" })).resolves.toBe(true);

    vi.resetModules();
    vi.stubEnv("LOGIN_HANDOFF_WORKSPACES", "");
    const emptied = await pilot();
    await expect(
      emptied.loginHandoffPilot({ workspaceId: "w-1" })
    ).resolves.toBe(true);
  });

  it("is off for everyone with `off`, the way back", async () => {
    vi.stubEnv("LOGIN_HANDOFF_WORKSPACES", "off");
    const { loginHandoffOn, loginHandoffPilot } = await pilot();
    expect(loginHandoffOn()).toBe(false);
    await expect(loginHandoffPilot({ workspaceId: "w-1" })).resolves.toBe(
      false
    );
  });

  it("narrows to the workspaces a list names", async () => {
    vi.stubEnv("LOGIN_HANDOFF_WORKSPACES", "w-1");
    const { loginHandoffPilot } = await pilot();
    await expect(loginHandoffPilot({ workspaceId: "w-1" })).resolves.toBe(true);
    await expect(loginHandoffPilot({ workspaceId: "w-2" })).resolves.toBe(
      false
    );
  });
});

describe("the agent's mailbox switch", () => {
  const scope = { userId: "u", workspaceId: "w-1" };

  async function enabled() {
    const { agentMailboxEnabled } = await import("@db/services/agent-mail");
    return agentMailboxEnabled(scope);
  }

  it("needs the key, then belongs to every workspace unless narrowed or off", async () => {
    expect(await enabled()).toBe(false);

    vi.resetModules();
    vi.stubEnv("AGENTMAIL_API_KEY", "key");
    expect(await enabled()).toBe(true);

    vi.resetModules();
    vi.stubEnv("AGENTMAIL_WORKSPACES", "off");
    expect(await enabled()).toBe(false);

    vi.resetModules();
    vi.stubEnv("AGENTMAIL_WORKSPACES", "w-1");
    expect(await enabled()).toBe(true);

    vi.resetModules();
    vi.stubEnv("AGENTMAIL_WORKSPACES", "w-2");
    expect(await enabled()).toBe(false);
  });
});

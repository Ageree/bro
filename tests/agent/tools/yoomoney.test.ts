import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  disconnectYoomoney,
  readYoomoneyConnection,
  withYoomoneyToken,
} from "@db/services/yoomoney/connection";
import type { startYoomoneyOnboarding } from "@db/services/yoomoney/onboarding";
import type * as Onboarding from "@agent/lib/yoomoney/onboarding";
import type * as Api from "@shared/yoomoney/api";

const services = vi.hoisted(() => ({
  button: vi.fn<typeof Onboarding.sendYoomoneyConnectButton>(),
  connection: vi.fn<typeof readYoomoneyConnection>(),
  enabled: vi.fn<typeof Api.yoomoneyEnabled>(),
  onboarding: vi.fn<typeof startYoomoneyOnboarding>(),
  withToken: vi.fn<typeof withYoomoneyToken>(),
}));

vi.mock("@db/services/yoomoney/connection", () => ({
  disconnectYoomoney: vi.fn<typeof disconnectYoomoney>(),
  readYoomoneyConnection: services.connection,
  withYoomoneyToken: services.withToken,
}));
vi.mock("@db/services/yoomoney/onboarding", () => ({
  startYoomoneyOnboarding: services.onboarding,
}));
vi.mock("@agent/lib/yoomoney/onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof Onboarding>()),
  sendYoomoneyConnectButton: services.button,
}));
vi.mock("@shared/yoomoney/api", async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  yoomoneyEnabled: services.enabled,
}));

import yoomoneyTools from "@agent/tools/yoomoney";

const telegramChat = {
  conversationChannel: "telegram",
  conversationId: "4242::",
  workspaceId: "workspace:alice",
};

function caller(
  authenticator: string,
  attributes: Readonly<Record<string, string>> = {
    conversationChannel: "eve",
    workspaceId: "workspace:alice",
  }
) {
  return {
    attributes,
    authenticator,
    principalId: "alice",
    principalType: "user" as const,
  };
}

async function tool(authenticator = "authjs") {
  const context: DynamicResolveContext = {
    channel: { kind: "channel:eve", metadata: {} },
    messages: [{ content: "Сколько у меня на ЮMoney?", role: "user" }],
    model: null,
    session: {
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
    },
  };
  const tools = await yoomoneyTools.events["step.started"]?.({}, context);
  return tools && "yoomoney" in tools ? tools.yoomoney : undefined;
}

const refuse = (): never => {
  throw new Error("Not used.");
};

function callContext(
  authenticator: string,
  attributes?: Readonly<Record<string, string>>
): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: refuse,
    getSkill: refuse,
    getToken: refuse,
    requireAuth: refuse,
    session: {
      auth: { current: caller(authenticator, attributes), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "yoomoney",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  services.enabled.mockReturnValue(true);
  services.connection.mockResolvedValue({ state: "disconnected" });
  services.onboarding.mockResolvedValue({
    id: "0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e12",
    url: "https://example.com/yoomoney/0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e12?t=x",
  });
  services.button.mockResolvedValue();
});

describe("the YooMoney tool", () => {
  it("is there only for the pilot, in a conversation of the person's", async () => {
    expect(await tool()).toBeDefined();
    expect(await tool("scheduled-worker")).toBeUndefined();
    services.enabled.mockReturnValue(false);
    expect(await tool()).toBeUndefined();
  });

  it("never reads the wallet in a browser report's turn", async () => {
    const found = await tool("browser-result");
    if (!found) throw new Error("Expected yoomoney.");
    expect(
      await found.execute({ action: "history" }, callContext("browser-result"))
    ).toMatchObject({ status: "refused" });
    expect(services.withToken).not.toHaveBeenCalled();
  });

  it("offers the onboarding page while the wallet is not connected", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected yoomoney.");
    services.withToken.mockResolvedValue({ connected: false });
    expect(
      await found.execute({ action: "balance" }, callContext("authjs"))
    ).toMatchObject({ status: "not_connected" });
    expect(
      await found.execute({ action: "connect" }, callContext("authjs"))
    ).toMatchObject({
      status: "authorize",
      url: "https://example.com/yoomoney/0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e12?t=x",
    });
    expect(services.onboarding).toHaveBeenCalledWith(
      { userId: "alice", workspaceId: "workspace:alice" },
      { conversationChannel: "eve", conversationId: "session-1" }
    );
    expect(services.button).not.toHaveBeenCalled();
  });

  it("puts a button to the page in a Telegram chat instead of a link", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected yoomoney.");
    const result = await found.execute(
      { action: "connect" },
      callContext("telegram-webhook", telegramChat)
    );
    expect(result).toMatchObject({ status: "authorize", sent: "button" });
    expect(result).not.toHaveProperty("url");
    expect(services.button).toHaveBeenCalledWith(
      "4242::",
      "https://example.com/yoomoney/0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e12?t=x",
      false
    );
    // A button Telegram did not take leaves the link.
    services.button.mockRejectedValue(new Error("Telegram is down."));
    expect(
      await found.execute(
        { action: "connect" },
        callContext("telegram-webhook", telegramChat)
      )
    ).toMatchObject({
      status: "authorize",
      url: "https://example.com/yoomoney/0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e12?t=x",
    });
  });

  it("gives the cabinet's link where the chat cannot be told again", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected yoomoney.");
    expect(
      await found.execute(
        { action: "connect" },
        callContext("authjs", { workspaceId: "workspace:alice" })
      )
    ).toMatchObject({
      status: "authorize",
      url: "https://example.com/api/yoomoney/connect",
    });
    expect(services.onboarding).not.toHaveBeenCalled();
  });

  it("offers the consent page again to a connected wallet only on reconnect", async () => {
    const found = await tool();
    if (!found) throw new Error("Expected yoomoney.");
    services.connection.mockResolvedValue({
      state: "connected",
      account: "4100111222333",
      connectedAt: new Date(),
    });
    expect(
      await found.execute({ action: "connect" }, callContext("authjs"))
    ).toMatchObject({ status: "connected" });
    expect(services.onboarding).not.toHaveBeenCalled();
    expect(
      await found.execute({ action: "reconnect" }, callContext("authjs"))
    ).toMatchObject({
      status: "authorize",
      url: "https://example.com/yoomoney/0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e12?t=x",
    });
  });
});

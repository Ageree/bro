import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  readYoomoneyConnection,
  withYoomoneyToken,
} from "@db/services/yoomoney";
import type { yoomoneyEnabled } from "@shared/yoomoney/api";

const services = vi.hoisted(() => ({
  connection: vi.fn<typeof readYoomoneyConnection>(),
  enabled: vi.fn<typeof yoomoneyEnabled>(),
  withToken: vi.fn<typeof withYoomoneyToken>(),
}));

vi.mock("@db/services/yoomoney", () => ({
  disconnectYoomoney: vi.fn(),
  readYoomoneyConnection: services.connection,
  withYoomoneyToken: services.withToken,
}));
vi.mock("@shared/yoomoney/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/yoomoney/api")>()),
  yoomoneyEnabled: services.enabled,
}));

import yoomoneyTools from "@agent/tools/yoomoney";

function caller(authenticator: string) {
  return {
    attributes: { conversationChannel: "eve", workspaceId: "workspace:alice" },
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

function callContext(authenticator: string): ToolContext {
  const refuse = (): never => {
    throw new Error("Not used.");
  };
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: refuse,
    getSkill: refuse,
    getToken: refuse,
    requireAuth: refuse,
    session: {
      auth: { current: caller(authenticator), initiator: null },
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

  it("offers the connect link while the wallet is not connected", async () => {
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
      url: "https://example.com/api/yoomoney/connect",
    });
  });
});

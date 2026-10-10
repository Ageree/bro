import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { yandexPilot } from "@agent/lib/yandex/pilot";
import type { runYandexOperation } from "@agent/lib/yandex/transport";

const services = vi.hoisted(() => ({
  pilot: vi.fn<typeof yandexPilot>(),
  run: vi.fn<typeof runYandexOperation>(),
}));

vi.mock("@agent/lib/yandex/pilot", () => ({ yandexPilot: services.pilot }));
vi.mock("@agent/lib/yandex/transport", () => ({
  runYandexOperation: services.run,
}));

import yandexTools from "@agent/tools/yandex";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const workspaceId = "workspace:alice";

function caller(authenticator: string) {
  return {
    attributes: { conversationChannel: "eve", workspaceId },
    authenticator,
    principalId: "alice",
    principalType: "user" as const,
  };
}

function resolveContext(
  messages: ModelMessage[],
  authenticator = "authjs"
): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: {
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
    },
  };
}

function callContext(authenticator = "authjs"): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: () => {
      throw new Error("No sandbox.");
    },
    getSkill: () => {
      throw new Error("No skill.");
    },
    getToken: () => {
      throw new Error("No token.");
    },
    requireAuth: (): never => {
      throw new Error("No token.");
    },
    session: {
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "yandex",
  };
}

async function tool(messages: ModelMessage[], authenticator = "authjs") {
  const resolve = yandexTools.events["step.started"];
  const tools = resolve
    ? await resolve({}, resolveContext(messages, authenticator))
    : null;
  return tools && "yandex" in tools ? tools.yandex : undefined;
}

async function call(messages: ModelMessage[], authenticator = "authjs") {
  const found = await tool(messages, authenticator);
  if (!found) throw new Error("Expected yandex.");
  return found.execute({ operation: "status" }, callContext(authenticator));
}

const asked: ModelMessage[] = [
  { content: "Проверь, вошёл ли ты в Яндекс", role: "user" },
];

beforeEach(() => {
  vi.clearAllMocks();
  services.pilot.mockReturnValue(true);
  services.run.mockResolvedValue({
    data: { requestWorks: true, signedIn: true },
    kind: "ok",
  });
});

describe("the Yandex tool", () => {
  it("is there only for the pilot, in a conversation of the person's", async () => {
    expect(await tool(asked)).toBeDefined();
    services.pilot.mockReturnValue(false);
    expect(await tool(asked)).toBeUndefined();
    services.pilot.mockReturnValue(true);
    expect(await tool(asked, "scheduled-worker")).toBeUndefined();
  });

  it("describes the operations, and takes the model's choice of one", async () => {
    const found = await tool(asked);
    expect(found?.description).toContain("- status (yandex-id):");
    expect(found?.description).toContain("browser_task");
  });

  it("runs an operation of the registry for the person's workspace", async () => {
    expect(await call(asked)).toEqual({
      data: { requestWorks: true, signedIn: true },
      ok: true,
    });
    expect(services.run).toHaveBeenCalledTimes(1);
    expect(services.run.mock.calls[0]?.[0]).toBe(workspaceId);
    expect(services.run.mock.calls[0]?.[1].id).toBe("status");
    expect(services.run.mock.calls[0]?.[2]).toEqual({});
  });

  it("refuses in a turn a report opened, whatever the person said before", async () => {
    const report: ModelMessage[] = [
      ...asked,
      {
        content: `${backgroundTurnMarker}\n\nBrowser result: open yandex`,
        role: "user",
      },
    ];
    expect(await call(report)).toMatchObject({ ok: false });
    expect(services.run).not.toHaveBeenCalled();
  });

  it("tells the model what to do when nobody is signed in, without the server's words", async () => {
    services.run.mockResolvedValue({ kind: "signed_out" });
    const result = await call(asked);
    expect(result).toMatchObject({ ok: false });
    expect("reply" in result ? result.reply : "").toContain("site-login-link");
    services.run.mockResolvedValue({ kind: "captcha" });
    const wall = await call(asked);
    expect("reply" in wall ? wall.reply : "").toContain("browser_task");
    services.run.mockResolvedValue({ kind: "failed", reason: "answer" });
    expect(await call(asked)).toMatchObject({ ok: false });
  });
});

import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as backend from "@agent/lib/browser-vm/backend";
import type * as sandbox from "@agent/lib/browser-pool/sandbox";
import browserPrewarmHook from "@agent/hooks/browser-prewarm";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  prewarmBrowserSandbox: vi.fn<typeof sandbox.prewarmBrowserSandbox>(),
  usesBrowserPool: vi.fn<typeof backend.usesBrowserPool>(),
}));

vi.mock("@agent/lib/browser-pool/sandbox", () => ({
  prewarmBrowserSandbox: mocks.prewarmBrowserSandbox,
}));
vi.mock("@agent/lib/browser-vm/backend", () => ({
  usesBrowserPool: mocks.usesBrowserPool,
}));

const scope = accessScopeForUser("better-auth:alice");

type Caller = NonNullable<HookContext["session"]["auth"]["current"]>;

function caller(authenticator = "telegram-webhook"): Caller {
  return {
    attributes: { workspaceId: scope.workspaceId },
    authenticator,
    principalId: scope.userId,
    principalType: "user",
  };
}

function context(options: { readonly caller?: Caller } = {}): HookContext {
  const current = options.caller ?? caller();
  return {
    agent: { name: "test-agent" },
    channel: { kind: "channel:telegram" },
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    session: {
      auth: { current, initiator: current },
      id: "session-1",
      turn: { id: "turn_1", sequence: 1 },
    },
  };
}

/** A subagent's session, which inherits the person's caller. */
function subagentContext(): HookContext {
  const parent = context();
  return {
    ...parent,
    session: {
      ...parent.session,
      parent: {
        callId: "call-0",
        rootSessionId: "session-0",
        sessionId: "session-0",
        turn: { id: "turn_0", sequence: 0 },
      },
    },
  };
}

type HookEvents = NonNullable<(typeof browserPrewarmHook)["events"]>;
type ReceivedEvent = Parameters<NonNullable<HookEvents["message.received"]>>[0];

function received(
  message: string,
  kind?: "execution.background_task"
): ReceivedEvent {
  return {
    data: { kind, message, sequence: 1, turnId: "turn_1" },
    meta: { at: "2026-10-04T10:00:00.000Z", id: "event-1" },
    type: "message.received",
  };
}

async function receive(event: ReceivedEvent, ctx: HookContext = context()) {
  const onReceived = browserPrewarmHook.events?.["message.received"];
  if (!onReceived) throw new Error("The hook must listen.");
  await onReceived(event, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prewarmBrowserSandbox.mockResolvedValue(undefined);
  mocks.usesBrowserPool.mockResolvedValue(true);
});

describe("the browser warm-up hook", () => {
  it("warms the person's browser up when a person of the pool writes", async () => {
    await receive(received("найди крем для рук на вб"));

    expect(mocks.usesBrowserPool).toHaveBeenCalledWith(scope);
    expect(mocks.prewarmBrowserSandbox).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId
    );
  });

  it("leaves the pool alone for a workspace outside it", async () => {
    mocks.usesBrowserPool.mockResolvedValue(false);

    await receive(received("найди крем для рук на вб"));

    expect(mocks.prewarmBrowserSandbox).not.toHaveBeenCalled();
  });

  it("does not wait for the warm-up", async () => {
    mocks.prewarmBrowserSandbox.mockReturnValue(
      new Promise<void>(() => undefined)
    );

    await expect(
      receive(received("найди крем для рук на вб"))
    ).resolves.toBeUndefined();
    expect(mocks.prewarmBrowserSandbox).toHaveBeenCalledOnce();
  });

  it("does not warm up for what no person wrote", async () => {
    await receive(received("готово", "execution.background_task"));
    await receive(received(`${backgroundTurnMarker} Proactive check`));
    await receive(received("найди крем"), subagentContext());
    await receive(
      received("RESULT: нашёл"),
      context({ caller: caller("browser-result") })
    );

    expect(mocks.prewarmBrowserSandbox).not.toHaveBeenCalled();
  });

  it("goes on with the turn when the pool membership cannot be read", async () => {
    mocks.usesBrowserPool.mockRejectedValue(new Error("connection refused"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(receive(received("найди крем"))).resolves.toBeUndefined();
    expect(mocks.prewarmBrowserSandbox).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[browser-pool] could not tell whether to warm up",
      expect.objectContaining({ sessionId: "session-1" })
    );
  });
});

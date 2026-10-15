import type { HookContext } from "eve/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

const pilot = vi.hoisted(() => ({
  taskFilesOfCaller: vi.fn<() => boolean>(() => true),
}));
vi.mock("@agent/lib/sandbox/pilot", () => pilot);

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

/** A task sandbox whose kit is already this release's. */
function sandbox() {
  return {
    run: vi.fn<
      (options: {
        readonly env?: Record<string, string>;
      }) => Promise<{ exitCode: number; stderr: string; stdout: string }>
    >(async () =>
      Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: '{"state":"current"}\n',
      })
    ),
    writeTextFile: vi.fn<() => Promise<void>>(),
  };
}

function context(getSandbox: () => Promise<ReturnType<typeof sandbox>>) {
  return {
    agent: { name: "task" },
    channel: {},
    async getSandbox() {
      // SAFETY: the hook runs commands and writes files only.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial sandbox stands in for eve's.
      return (await getSandbox()) as never;
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes: { workspaceId },
          authenticator: "telegram-webhook",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-task",
      parent: {
        callId: "call-1",
        rootSessionId: "session-bro",
        sessionId: "session-bro",
        turn: { id: "turn_3", sequence: 3 },
      },
      turn: { id: "turn_0", sequence: 0 },
    },
  } satisfies HookContext;
}

async function received(ctx: ReturnType<typeof context>) {
  const { default: hook } = await importWithSandbox(
    async () => await import("@agent/subagents/task/hooks/kit")
  );
  const handler = hook.events?.["message.received"];
  // SAFETY: the hook reads nothing of the event.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
  await handler?.({ data: { message: "Сделай отчёт" } } as never, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  pilot.taskFilesOfCaller.mockReturnValue(true);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  clearSandboxSettings();
  vi.restoreAllMocks();
});

describe("the kit hook of the task agent", () => {
  it("keeps the kit and this workspace's mark token in the sandbox", async () => {
    const open = sandbox();
    await received(context(async () => Promise.resolve(open)));

    const { signMarkToken } = await import("@agent/lib/sandbox/keys");
    expect(open.run).toHaveBeenCalledOnce();
    expect(open.run.mock.lastCall?.[0].env?.BROKIT_TOKEN).toBe(
      signMarkToken(workspaceId)
    );
    expect(signMarkToken(workspaceId)).toMatch(/^[\da-f]{32}$/u);
    expect(console.info).toHaveBeenCalledWith(
      "[task-kit]",
      expect.objectContaining({ result: "current" })
    );
  });

  it("opens no sandbox where the person's files do not reach the task agent", async () => {
    pilot.taskFilesOfCaller.mockReturnValue(false);
    const getSandbox = vi.fn<() => Promise<ReturnType<typeof sandbox>>>();

    await received(context(getSandbox));

    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("never fails the turn, and logs a failure by its name alone", async () => {
    await received(
      context(async () =>
        Promise.reject(new TypeError("sandbox sb-123 at 10.0.0.1 is gone"))
      )
    );

    expect(console.warn).toHaveBeenCalledWith("[task-kit] not delivered", {
      error: "TypeError",
    });
  });
});

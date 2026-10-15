import type { HookContext } from "eve/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

type Kind = "exec" | "open" | "other" | "stop";
type Answer = () => Promise<Response> | Response;

/** sandboxd as a stand-in: each kind of request takes its next answer. */
function stubHost(answers: Partial<Record<Kind, Answer[]>>) {
  const calls: { readonly kind: Kind; readonly url: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const kind: Kind =
      init.method === "PUT" && !path.endsWith("/files")
        ? "open"
        : path.endsWith("/stop")
          ? "stop"
          : path.endsWith("/exec")
            ? "exec"
            : "other";
    calls.push({ kind, url });
    const answer = answers[kind]?.shift();
    if (!answer) throw new Error(`The test ran out of ${kind} answers.`);
    return await answer();
  });
  return calls;
}

const opened = () =>
  Response.json({ created: true, id: "sb", restored: true, state: "running" });
const full = () =>
  Response.json(
    {
      error: "host_full",
      message:
        "1280 MiB more (headroom included) would exceed the host's 9216 MiB (9216 MiB committed)",
    },
    { status: 507 }
  );
const stoppedAnswer = () => Response.json({ bytes: 1024, ms: 40 });

/** An answer held back until the test lets it go. */
function gate(answer: Answer) {
  let open!: () => void;
  const opening = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    answer: async () => {
      await opening;
      return await answer();
    },
    open: () => {
      open();
    },
  };
}

async function load() {
  return await importWithSandbox(async () => {
    const [backend, keys, ownHook, taskHook] = await Promise.all([
      import("@agent/lib/sandbox/backend"),
      import("@agent/lib/sandbox/keys"),
      import("@agent/hooks/sandbox-release"),
      import("@agent/subagents/task/hooks/sandbox-release"),
    ]);
    const create = async (sessionKey: string, sessionId: string) =>
      await backend.cloudRuSandbox().create({
        existingMetadata: { sandboxId: "old", workspaceId: "personal:abc" },
        runtimeContext: { appRoot: "/app" },
        sessionKey,
        tags: { agent: "bro", channel: "telegram", sessionId },
        templateKey: null,
      });
    const turnEnds = async (
      hook: typeof ownHook.default,
      sessionId: string,
      event: "turn.completed" | "turn.failed" = "turn.completed"
    ) => {
      // SAFETY: the hook reads nothing of the event.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
      await hook.events?.[event]?.({} as never, context(sessionId));
    };
    return {
      create,
      ownTurnEnds: async (sessionId: string) => {
        await turnEnds(ownHook.default, sessionId);
      },
      sandboxIdFor: keys.sandboxIdFor,
      taskTurnEnds: async (
        sessionId: string,
        event?: "turn.completed" | "turn.failed"
      ) => {
        await turnEnds(taskHook.default, sessionId, event);
      },
    };
  });
}

function context(sessionId: string) {
  return {
    agent: { name: "bro" },
    channel: {},
    getSandbox() {
      throw new Error("A release must not open a sandbox to stop it.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    session: {
      auth: { current: null, initiator: null },
      id: sessionId,
      turn: { id: "turn_1", sequence: 1 },
    },
  } satisfies HookContext;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  clearSandboxSettings();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("room on the shared code host", () => {
  it("waits out a full host and opens once there is room", async () => {
    vi.useFakeTimers();
    const calls = stubHost({ open: [full, full, opened] });
    const { create } = await load();

    const opening = create("session-1", "bro-1");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(opening).resolves.toMatchObject({ session: {} });
    expect(calls.map(({ kind }) => kind)).toEqual(["open", "open", "open"]);
    expect(console.warn).toHaveBeenCalledWith(
      "[sandbox] host full, waiting",
      expect.objectContaining({ attempt: 2, waitMs: 4_000 })
    );
  });

  it("fails clearly once the host stayed full for 90 s", async () => {
    vi.useFakeTimers();
    const calls = stubHost({ open: Array.from({ length: 7 }, () => full) });
    const { create } = await load();

    const opening = create("session-1", "bro-1");
    await Promise.all([
      expect(opening).rejects.toThrow("stayed full for 90 s"),
      expect(opening).rejects.toMatchObject({
        cause: { code: "host_full", status: 507 },
      }),
      (async () => {
        await vi.advanceTimersByTimeAsync(89_999);
        expect(calls).toHaveLength(6);
        await vi.advanceTimersByTimeAsync(1);
      })(),
    ]);
    expect(calls).toHaveLength(7);
  });

  it("does not wait on any other refusal of the host", async () => {
    const calls = stubHost({
      open: [() => Response.json({ error: "rootfs_missing" }, { status: 500 })],
    });
    const { create } = await load();

    await expect(create("session-1", "bro-1")).rejects.toThrow(
      "rootfs_missing"
    );
    expect(calls).toHaveLength(1);
  });

  it("stops the task agent's sandbox as its turn ends, and a continuation restores it after the stop", async () => {
    const stop = gate(stoppedAnswer);
    const calls = stubHost({ open: [opened, opened], stop: [stop.answer] });
    const { create, sandboxIdFor, taskTurnEnds } = await load();
    await create("task-key", "task-1");

    await taskTurnEnds("task-1");
    await vi.waitFor(() => {
      expect(calls.map(({ kind }) => kind)).toEqual(["open", "stop"]);
    });
    expect(calls[1]?.url).toBe(
      `https://10-0-0-1.sslip.io/v1/sandboxes/${sandboxIdFor("task-key")}/stop`
    );
    // Bro continues the task while the snapshot is still being taken.
    const continuation = create("task-key", "task-1");
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(calls).toHaveLength(2);
    stop.open();

    await continuation;
    expect(calls.map(({ kind }) => kind)).toEqual(["open", "stop", "open"]);
  });

  it("keeps Bro's own sandbox through the grace for the next turn, and stops it after the last", async () => {
    vi.useFakeTimers();
    const calls = stubHost({ open: [opened, opened], stop: [stoppedAnswer] });
    const { create, ownTurnEnds } = await load();
    await create("bro-key", "bro-1");
    await ownTurnEnds("bro-1");
    await vi.advanceTimersByTimeAsync(30_000);

    // The next message comes within the grace: its turn has the sandbox.
    await create("bro-key", "bro-1");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.map(({ kind }) => kind)).toEqual(["open", "open"]);

    await ownTurnEnds("bro-1");
    await vi.advanceTimersByTimeAsync(299_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map(({ kind }) => kind)).toEqual(["open", "open", "stop"]);
  });

  it("stops nothing for a turn that did not open the sandbox", async () => {
    vi.useFakeTimers();
    const calls = stubHost({ open: [opened] });
    const { create, ownTurnEnds } = await load();
    await create("bro-key", "bro-1");

    await ownTurnEnds("bro-2");
    await vi.advanceTimersByTimeAsync(120_000);

    expect(calls.map(({ kind }) => kind)).toEqual(["open"]);
  });

  it("waits for a command still running before it stops the sandbox", async () => {
    vi.useFakeTimers();
    const command = gate(() =>
      Response.json({ code: 0, type: "exit" }, { status: 200 })
    );
    const calls = stubHost({
      exec: [command.answer],
      open: [opened],
      stop: [stoppedAnswer],
    });
    const { create, taskTurnEnds } = await load();
    const { session } = await create("task-key", "task-1");
    const running = session.run({ command: "sleep 30" });

    await taskTurnEnds("task-1", "turn.failed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.map(({ kind }) => kind)).toEqual(["open", "exec"]);
    command.open();
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls.map(({ kind }) => kind)).toEqual(["open", "exec", "stop"]);
  });

  it("logs a stop the host refuses by its code alone and carries on", async () => {
    const calls = stubHost({
      open: [opened, opened],
      stop: [
        () =>
          Response.json(
            {
              error: "snapshot_failed",
              message: "tar: ./Паспорт Иванова.pdf: Cannot open",
            },
            { status: 502 }
          ),
      ],
    });
    const { create, taskTurnEnds } = await load();
    await create("task-key", "task-1");

    await taskTurnEnds("task-1");
    await vi.waitFor(() => {
      expect(console.warn).toHaveBeenCalledWith(
        "[sandbox] not stopped after its turn",
        expect.objectContaining({ code: "snapshot_failed", status: 502 })
      );
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "Паспорт"
    );

    await expect(create("task-key", "task-1")).resolves.toBeDefined();
    expect(calls.map(({ kind }) => kind)).toEqual(["open", "stop", "open"]);
  });

  it("makes room on a full host from its own sandboxes still in their grace", async () => {
    vi.useFakeTimers();
    const calls = stubHost({
      open: [opened, full, opened],
      stop: [stoppedAnswer],
    });
    const { create, ownTurnEnds, sandboxIdFor } = await load();
    await create("bro-key", "bro-1");
    await ownTurnEnds("bro-1");

    // Another person's task agent needs room while Bro's sandbox waits.
    await create("task-key", "task-1");

    expect(calls.map(({ kind }) => kind)).toEqual([
      "open",
      "open",
      "stop",
      "open",
    ]);
    expect(calls[2]?.url).toContain(sandboxIdFor("bro-key"));
    expect(console.warn).not.toHaveBeenCalledWith(
      "[sandbox] host full, waiting",
      expect.anything()
    );
  });

  it("tries a full host again as soon as its own stop on the way is done", async () => {
    const stop = gate(stoppedAnswer);
    const calls = stubHost({
      open: [opened, full, opened],
      stop: [stop.answer],
    });
    const { create, taskTurnEnds } = await load();
    await create("task-key", "task-1");
    await taskTurnEnds("task-1");
    await vi.waitFor(() => {
      expect(calls.map(({ kind }) => kind)).toEqual(["open", "stop"]);
    });

    // Another person's task agent needs room while the finished one is
    // still being snapshotted.
    const opening = create("task-key-2", "task-2");
    await vi.waitFor(() => {
      expect(calls).toHaveLength(3);
    });
    stop.open();

    await expect(opening).resolves.toBeDefined();
    expect(calls.map(({ kind }) => kind)).toEqual([
      "open",
      "stop",
      "open",
      "open",
    ]);
    expect(console.warn).not.toHaveBeenCalledWith(
      "[sandbox] host full, waiting",
      expect.anything()
    );
  });

  it("does not let a slow own stop hold an open of a full host", async () => {
    vi.useFakeTimers();
    const stop = gate(stoppedAnswer);
    const calls = stubHost({
      open: [opened, full, opened],
      stop: [stop.answer],
    });
    const { create, ownTurnEnds } = await load();
    await create("bro-key", "bro-1");
    await ownTurnEnds("bro-1");

    const opening = create("task-key", "task-1");
    await vi.advanceTimersByTimeAsync(32_000);

    await expect(opening).resolves.toBeDefined();
    expect(calls.map(({ kind }) => kind)).toEqual([
      "open",
      "open",
      "stop",
      "open",
    ]);
    stop.open();
    await vi.advanceTimersByTimeAsync(0);
  });
});

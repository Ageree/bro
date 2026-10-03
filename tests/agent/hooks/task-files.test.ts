import { createHash } from "node:crypto";
import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as inbox from "@agent/lib/sandbox/inbox";

const stateControls = vi.hoisted(() => ({
  // SAFETY: The array is populated only with zero-argument reset callbacks created by this mock.
  reset: [] as (() => void)[],
}));

vi.mock("eve/context", () => ({
  defineState<T>(_name: string, initial: () => T) {
    let value = initial();
    stateControls.reset.push(() => {
      value = initial();
    });
    return {
      get: () => value,
      update(update: (current: T) => T) {
        value = update(value);
      },
    };
  },
}));

const pilot = vi.hoisted(() => ({
  taskFilesOfCaller: vi.fn<() => boolean>(() => true),
}));
vi.mock("@agent/lib/sandbox/pilot", () => pilot);

const putInbox = vi.hoisted(() =>
  vi.fn<typeof inbox.putInbox>(() => Promise.resolve())
);
vi.mock("@agent/lib/sandbox/inbox", async (importOriginal) => ({
  ...(await importOriginal<typeof inbox>()),
  putInbox,
}));

import taskFilesHook from "@agent/hooks/task-files";
import { inboxKey } from "@agent/lib/sandbox/inbox";

const workspaceId = "personal:0123456789abcdef0123456789abcdef";

function staged(name: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { bytes, path: `/workspace/attachments/${hash}/${name}` };
}

const table = staged("report.xlsx", "table");
const deck = staged("deck.pptx", "deck");

function sandboxOf(files: readonly { bytes: Uint8Array; path: string }[]) {
  return {
    readBinaryFile: vi.fn<
      (options: { path: string }) => Promise<Uint8Array | null>
    >(({ path }) =>
      Promise.resolve(files.find((file) => file.path === path)?.bytes ?? null)
    ),
  };
}

function context(
  options: {
    readonly authenticator?: string;
    readonly attributes?: Readonly<Record<string, string>>;
    readonly sandbox?: ReturnType<typeof sandboxOf> | null;
  } = {},
  session: Pick<HookContext["session"], "parent"> = {}
) {
  const sandbox =
    options.sandbox === undefined ? sandboxOf([table, deck]) : options.sandbox;
  return {
    agent: { name: "bro" },
    channel: { continuationToken: "conversation" },
    async getSandbox() {
      if (sandbox === null) throw new Error("No sandbox here.");
      // SAFETY: the hook reads files only; the rest of a sandbox stays out.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial sandbox stands in for eve's.
      return await Promise.resolve(sandbox as never);
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes: { workspaceId, ...options.attributes },
          authenticator: options.authenticator ?? "telegram-webhook",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn_3", sequence: 3 },
      ...session,
    },
  } satisfies HookContext;
}

type Ctx = ReturnType<typeof context>;

type Events = NonNullable<typeof taskFilesHook.events>;
/** The part of an event the hook reads; the rest stays out of these cases. */
interface EventData {
  readonly actions?: readonly ReturnType<typeof taskCall>[];
  readonly kind?: "execution.background_task";
  readonly message?: string;
  readonly sequence: number;
  readonly stepIndex?: number;
  readonly turnId: string;
}

async function emit(name: keyof Events, data: EventData, ctx: Ctx = context()) {
  const handler = taskFilesHook.events?.[name];
  // SAFETY: each case builds only the fields of the event the hook reads.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
  await handler?.({ data } as never, ctx);
}

async function personTurn(ctx: Ctx = context(), turnId = "turn_3") {
  await emit("turn.started", { sequence: 3, turnId }, ctx);
  await emit(
    "message.received",
    { message: "Разбери таблицу", sequence: 3, turnId },
    ctx
  );
}

function taskCall(message: string, toolName = "task", kind = "tool-call") {
  return {
    callId: `call-${toolName}`,
    input: { message },
    kind,
    toolName,
  };
}

async function requested(
  actions: readonly ReturnType<typeof taskCall>[],
  ctx: Ctx = context(),
  turnId = "turn_3",
  stepIndex = 1
) {
  await emit(
    "actions.requested",
    { actions, sequence: 3, stepIndex, turnId },
    ctx
  );
}

beforeEach(() => {
  for (const reset of stateControls.reset) reset();
  vi.clearAllMocks();
  pilot.taskFilesOfCaller.mockReturnValue(true);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the person's files for the task agent", () => {
  it("copies the files a `task` call names in the person's turn", async () => {
    const ctx = context();
    await personTurn(ctx);
    await requested(
      [taskCall(`Посчитай итог:\n${table.path} — report.xlsx\n${deck.path}`)],
      ctx
    );

    expect(putInbox.mock.calls).toEqual([
      [
        inboxKey(workspaceId, "session-1", table.path),
        table.bytes,
        expect.any(AbortSignal),
      ],
      [
        inboxKey(workspaceId, "session-1", deck.path),
        deck.bytes,
        expect.any(AbortSignal),
      ],
    ]);
    expect(console.info).toHaveBeenCalledWith("[task-files] mirrored", {
      failed: 0,
      mirrored: 2,
      named: 2,
    });
  });

  it("ignores eve's internal subagent dispatch and other tools", async () => {
    await personTurn();
    await requested([
      taskCall(table.path, "task", "subagent-call"),
      taskCall(table.path, "web_fetch"),
    ]);

    expect(putInbox).not.toHaveBeenCalled();
  });

  it("copies nothing once the task agent's report came into the turn", async () => {
    const ctx = context();
    await emit("turn.started", { sequence: 3, turnId: "turn_3" }, ctx);
    await emit(
      "message.received",
      {
        kind: "execution.background_task",
        message: "Background task task_1 (task) is completed.",
        sequence: 3,
        turnId: "turn_3",
      },
      ctx
    );
    // The person writes while the report's turn runs: it stays the report's.
    await emit(
      "message.received",
      { message: "Ещё разок", sequence: 3, turnId: "turn_3" },
      ctx
    );
    await requested([taskCall(table.path)], ctx);

    expect(putInbox).not.toHaveBeenCalled();
  });

  it("knows the report by its words when the kind is missing", async () => {
    const ctx = context();
    await emit("turn.started", { sequence: 3, turnId: "turn_3" }, ctx);
    await emit(
      "message.received",
      {
        message: "Background task task_1 (task) failed.",
        sequence: 3,
        turnId: "turn_3",
      },
      ctx
    );
    await requested([taskCall(table.path)], ctx);

    expect(putInbox).not.toHaveBeenCalled();
  });

  it("copies nothing for a browser report, a worker or a subagent", async () => {
    for (const ctx of [
      context({
        attributes: { browserRunId: "run-1" },
        authenticator: "browser-result",
      }),
      context({ authenticator: "scheduled-worker" }),
      context(
        {},
        {
          parent: {
            callId: "call-1",
            rootSessionId: "session-0",
            sessionId: "session-0",
            turn: { id: "turn_0", sequence: 0 },
          },
        }
      ),
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each caller is its own case.
      await personTurn(ctx);
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      await requested([taskCall(table.path)], ctx);
    }

    expect(putInbox).not.toHaveBeenCalled();
  });

  it("copies nothing in another turn, or one that brought no message", async () => {
    const ctx = context();
    await personTurn(ctx, "turn_2");
    await requested([taskCall(table.path)], ctx);
    // A turn that resumes after a card starts without a message.
    await emit("turn.started", { sequence: 3, turnId: "turn_3" }, ctx);
    await requested([taskCall(table.path)], ctx);

    expect(putInbox).not.toHaveBeenCalled();
  });

  it("copies nothing without the pilot", async () => {
    pilot.taskFilesOfCaller.mockReturnValue(false);
    const sandbox = sandboxOf([table]);
    const ctx = context({ sandbox });
    await personTurn(ctx);
    await requested([taskCall(table.path)], ctx);

    expect(sandbox.readBinaryFile).not.toHaveBeenCalled();
    expect(putInbox).not.toHaveBeenCalled();
  });

  it("skips a missing file or another file under the path", async () => {
    const forged = {
      bytes: new TextEncoder().encode("other"),
      path: deck.path,
    };
    const ctx = context({ sandbox: sandboxOf([forged]) });
    await personTurn(ctx);
    await requested([taskCall(`${table.path}\n${deck.path}`)], ctx);

    expect(putInbox).not.toHaveBeenCalled();
  });

  it("never fails the turn: no sandbox, or Object Storage down", async () => {
    const without = context({ sandbox: null });
    await personTurn(without);
    await expect(
      requested([taskCall(table.path)], without)
    ).resolves.toBeUndefined();

    putInbox.mockRejectedValueOnce(new Error("Object Storage 500"));
    const ctx = context();
    await personTurn(ctx);
    await requested([taskCall(`${table.path}\n${deck.path}`)], ctx);

    expect(putInbox).toHaveBeenCalledTimes(2);
    expect(console.info).toHaveBeenCalledWith("[task-files] mirrored", {
      failed: 1,
      mirrored: 1,
      named: 2,
    });
  });

  it("copies at most ten files a step, and a replay to the same keys", async () => {
    const files = Array.from({ length: 12 }, (_, index) =>
      staged(`f${String(index)}.csv`, `file ${String(index)}`)
    );
    const ctx = context({ sandbox: sandboxOf(files) });
    await personTurn(ctx);
    const call = taskCall(files.map((file) => file.path).join("\n"));
    await requested([call], ctx);
    await requested([call], ctx);

    expect(putInbox).toHaveBeenCalledTimes(20);
    const keys = putInbox.mock.calls.map(([key]) => key);
    expect(keys.slice(10)).toEqual(keys.slice(0, 10));
    expect(new Set(keys).size).toBe(10);
  });

  it("counts ten files for all of a step's calls, each its own event", async () => {
    const files = Array.from({ length: 21 }, (_, index) =>
      staged(`f${String(index)}.csv`, `file ${String(index)}`)
    );
    const ctx = context({ sandbox: sandboxOf(files) });
    await personTurn(ctx);
    const paths = files.map((file) => file.path);
    // eve emits one `actions.requested` a streamed call.
    await requested([taskCall(paths.slice(0, 6).join("\n"))], ctx);
    await requested([taskCall(paths.slice(6, 16).join("\n"))], ctx);

    expect(putInbox).toHaveBeenCalledTimes(10);

    // The next step has a budget of its own.
    await requested([taskCall(paths[20] ?? "")], ctx, "turn_3", 2);
    expect(putInbox).toHaveBeenCalledTimes(11);
  });

  it("ends a step's copying at one deadline for all its calls", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const ctx = context();
      await personTurn(ctx);
      await requested([taskCall(table.path)], ctx);
      vi.setSystemTime(Date.now() + 21_000);
      await requested([taskCall(deck.path)], ctx);

      expect(putInbox).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

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

const getInbox = vi.hoisted(() =>
  vi.fn<typeof inbox.getInbox>(() => Promise.resolve(null))
);
vi.mock("@agent/lib/sandbox/inbox", async (importOriginal) => ({
  ...(await importOriginal<typeof inbox>()),
  getInbox,
}));

import personFilesHook from "@agent/subagents/task/hooks/person-files";
import { inboxKey } from "@agent/lib/sandbox/inbox";

const workspaceId = "personal:0123456789abcdef0123456789abcdef";
const notReceived = "/workspace/attachments/NOT_RECEIVED.txt";
const parent = {
  callId: "call-1",
  rootSessionId: "session-bro",
  sessionId: "session-bro",
  turn: { id: "turn_3", sequence: 3 },
};

function staged(name: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { bytes, path: `/workspace/attachments/${hash}/${name}` };
}

const table = staged("report.xlsx", "table");
const deck = staged("deck.pptx", "deck");

/** The task agent's sandbox as a map of paths to bytes. */
function sandboxOf(
  initial: readonly { bytes: Uint8Array; path: string }[] = []
) {
  const files = new Map(initial.map((file) => [file.path, file.bytes]));
  return {
    files,
    readBinaryFile: vi.fn<
      (options: { path: string }) => Promise<Uint8Array | null>
    >(({ path }) => Promise.resolve(files.get(path) ?? null)),
    removePath: vi.fn<(options: { path: string }) => Promise<void>>(
      ({ path }) => {
        files.delete(path);
        return Promise.resolve();
      }
    ),
    writeBinaryFile: vi.fn<
      (options: { content: Uint8Array; path: string }) => Promise<void>
    >(({ content, path }) => {
      files.set(path, content);
      return Promise.resolve();
    }),
    writeTextFile: vi.fn<
      (options: { content: string; path: string }) => Promise<void>
    >(({ content, path }) => {
      files.set(path, new TextEncoder().encode(content));
      return Promise.resolve();
    }),
  };
}

function context(
  sandbox: ReturnType<typeof sandboxOf>,
  session: { readonly parent?: HookContext["session"]["parent"] } = { parent }
) {
  return {
    agent: { name: "task" },
    channel: {},
    async getSandbox() {
      // SAFETY: the hook reads, writes and removes files only.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial sandbox stands in for eve's.
      return await Promise.resolve(sandbox as never);
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
      turn: { id: "turn_0", sequence: 0 },
      ...session,
    },
  } satisfies HookContext;
}

let turnSequence = 0;

/** A message that opens a turn of its own, unless `turnId` names one. */
async function received(
  message: string,
  ctx: ReturnType<typeof context>,
  turnId?: string
) {
  const handler = personFilesHook.events?.["message.received"];
  turnSequence += 1;
  const turn = turnId ?? `turn_${String(turnSequence)}`;
  const event = { data: { message, sequence: 0, turnId: turn } };
  // SAFETY: the hook reads only the message's text and its turn.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
  await handler?.(event as never, ctx);
}

/** eve's first message to a subagent wraps Bro's text (`subagents/invocation.js`). */
function firstMessage(message: string) {
  return [
    'You are the subagent "task".',
    "Description: Your helper with its own Linux computer.",
    "",
    "The caller delegated the following task to you. Complete it and return the result directly. The caller may send follow-up messages after you answer.",
    "",
    "Caller message:",
    message,
  ].join("\n");
}

function inboxHolds(...files: readonly ReturnType<typeof staged>[]) {
  getInbox.mockImplementation((key) =>
    Promise.resolve(
      files.find(
        (file) => inboxKey(workspaceId, "session-bro", file.path) === key
      )?.bytes ?? null
    )
  );
}

function text(bytes: Uint8Array | undefined) {
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

beforeEach(() => {
  for (const reset of stateControls.reset) reset();
  vi.clearAllMocks();
  pilot.taskFilesOfCaller.mockReturnValue(true);
  getInbox.mockResolvedValue(null);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the person's files in the task agent's sandbox", () => {
  it("puts each named file at the path Bro wrote, from the first message", async () => {
    inboxHolds(table, deck);
    const sandbox = sandboxOf();
    await received(
      firstMessage(
        `Посчитай итог в ${table.path} (report.xlsx).\n${deck.path}`
      ),
      context(sandbox)
    );

    expect(sandbox.files.get(table.path)).toEqual(table.bytes);
    expect(sandbox.files.get(deck.path)).toEqual(deck.bytes);
    expect(sandbox.files.has(notReceived)).toBe(false);
    // Only this workspace's and this conversation's inbox is asked.
    expect(getInbox.mock.calls.map(([key]) => key)).toEqual([
      inboxKey(workspaceId, "session-bro", table.path),
      inboxKey(workspaceId, "session-bro", deck.path),
    ]);
  });

  it("lists what did not arrive, then takes the list away once all did", async () => {
    inboxHolds(table);
    const sandbox = sandboxOf();
    const ctx = context(sandbox);
    await received(firstMessage(`${table.path}\n${deck.path}`), ctx);

    expect(text(sandbox.files.get(notReceived))).toBe(
      `Не дошли файлы из последнего сообщения Бро, где он назвал файлы:\n${deck.path} — Бро не передал этот файл\n`
    );

    // A continuation comes as Bro's own text.
    inboxHolds(table, deck);
    await received(`Вот ещё раз: ${deck.path}`, ctx);

    expect(sandbox.files.get(deck.path)).toEqual(deck.bytes);
    expect(sandbox.files.has(notReceived)).toBe(false);
  });

  it("refuses bytes that are not the file the path names", async () => {
    getInbox.mockResolvedValue(new TextEncoder().encode("other"));
    const sandbox = sandboxOf();
    await received(table.path, context(sandbox));

    expect(sandbox.files.has(table.path)).toBe(false);
    expect(text(sandbox.files.get(notReceived))).toContain(
      `${table.path} — файл пришёл повреждённым`
    );
  });

  it("never overwrites a file already there, and asks nothing twice", async () => {
    inboxHolds(table);
    const changed = new TextEncoder().encode("worked on");
    const sandbox = sandboxOf([{ bytes: changed, path: table.path }]);
    const ctx = context(sandbox);
    await received(table.path, ctx);
    await received(table.path, ctx);

    expect(sandbox.files.get(table.path)).toEqual(changed);
    expect(getInbox).not.toHaveBeenCalled();
    expect(sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });

  it("does nothing outside a task, without the pilot or without paths", async () => {
    const sandbox = sandboxOf();
    await received(table.path, context(sandbox, {}));
    pilot.taskFilesOfCaller.mockReturnValue(false);
    await received(table.path, context(sandbox));
    pilot.taskFilesOfCaller.mockReturnValue(true);
    await received("Сделай презентацию про котов", context(sandbox));

    expect(getInbox).not.toHaveBeenCalled();
    expect(sandbox.readBinaryFile).not.toHaveBeenCalled();
    expect(sandbox.files.size).toBe(0);
  });

  it("never fails the task: Object Storage down or the sandbox refusing", async () => {
    getInbox.mockRejectedValue(new Error("Object Storage 500"));
    const sandbox = sandboxOf();
    await expect(
      received(table.path, context(sandbox))
    ).resolves.toBeUndefined();
    expect(text(sandbox.files.get(notReceived))).toContain(
      `${table.path} — не удалось получить файл`
    );

    sandbox.writeTextFile.mockRejectedValue(new Error("host down"));
    await expect(
      received(table.path, context(sandbox))
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      "[task-files] files not received",
      { error: "Error" }
    );
  });

  it("brings ten files a message and lists the rest", async () => {
    const files = Array.from({ length: 11 }, (_, index) =>
      staged(`f${String(index)}.csv`, `file ${String(index)}`)
    );
    inboxHolds(...files);
    const sandbox = sandboxOf();
    await received(files.map((file) => file.path).join("\n"), context(sandbox));

    expect(getInbox).toHaveBeenCalledTimes(10);
    expect(text(sandbox.files.get(notReceived))).toContain(
      `${files[10]?.path ?? ""} — больше 10 файлов в одном сообщении`
    );
  });

  it("asks again for a while for a file of a message steered into the turn", async () => {
    vi.useFakeTimers();
    try {
      const sandbox = sandboxOf();
      const ctx = context(sandbox);
      await received(firstMessage("Сделай отчёт"), ctx, "turn_0");
      // Bro's hook is still copying when the steered message comes.
      getInbox.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      getInbox.mockResolvedValue(table.bytes);
      const steered = received(`И вот таблица: ${table.path}`, ctx, "turn_0");
      await vi.advanceTimersByTimeAsync(3000);
      await steered;

      expect(getInbox).toHaveBeenCalledTimes(3);
      expect(sandbox.files.get(table.path)).toEqual(table.bytes);
      expect(sandbox.files.has(notReceived)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks once for a file of a message that opens its turn", async () => {
    const sandbox = sandboxOf();
    await received(firstMessage(table.path), context(sandbox), "turn_0");

    expect(getInbox).toHaveBeenCalledTimes(1);
    expect(text(sandbox.files.get(notReceived))).toContain(
      `${table.path} — Бро не передал этот файл`
    );
  });

  it("replaces the list when a later message names files by a broken path", async () => {
    const sandbox = sandboxOf();
    const ctx = context(sandbox);
    await received(table.path, ctx);
    expect(text(sandbox.files.get(notReceived))).toContain(table.path);

    // A hash one digit short matches no staged file.
    const broken = deck.path.replace(/\/[\da-f]{16}\//u, "/0123456789abcde/");
    await received(`Вот презентация: ${broken}`, ctx);

    const list = text(sandbox.files.get(notReceived)) ?? "";
    expect(list).not.toContain(table.path);
    expect(list).toContain("путь в сообщении Бро не похож на переданный файл");
  });
});

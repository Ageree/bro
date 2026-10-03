import { createHash } from "node:crypto";
import type { HookContext } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as inbox from "@agent/lib/sandbox/inbox";

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

async function received(message: string, ctx: ReturnType<typeof context>) {
  const handler = personFilesHook.events?.["message.received"];
  // SAFETY: the hook reads only the message's text.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
  await handler?.({ data: { message } } as never, ctx);
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
      `Эти файлы из последнего сообщения Бро не дошли:\n${deck.path} — Бро не передал этот файл\n`
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
});

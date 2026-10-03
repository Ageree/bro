import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = {
  BROWSER_STATE_BUCKET: "bro-state-test",
  CLOUDRU_KEY_ID: "test-key-id",
  CLOUDRU_KEY_SECRET: "test-key-secret",
  CLOUDRU_S3_TENANT_ID: "test-tenant",
};

beforeEach(() => {
  vi.resetModules();
  for (const [name, value] of Object.entries(storage)) vi.stubEnv(name, value);
});

afterEach(() => {
  for (const name of Object.keys(storage)) vi.stubEnv(name, "");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function loadInbox() {
  return await import("@agent/lib/sandbox/inbox");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const bytes = new Uint8Array([1, 2, 3]);
const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const path = `/workspace/attachments/${hash}/report.xlsx`;

/** An object's date as Object Storage sends it, this many minutes ago. */
function storedAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toUTCString();
}

function stubStorage(...answers: readonly (Error | Response)[]) {
  const calls: { method: string; url: URL }[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? "GET", url: new URL(url) });
    const answer = answers[calls.length - 1];
    if (answer === undefined) {
      throw new Error("The test ran out of stubbed answers.");
    }
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  });
  return calls;
}

describe("the paths Bro names", () => {
  it("finds staged paths in a text, each once, in order", async () => {
    const { namedAttachmentPaths } = await loadInbox();
    const other = `/workspace/attachments/${"a".repeat(16)}/deck.pptx`;

    expect(
      namedAttachmentPaths(
        `Разбери ${path} (таблица).\nПотом \`${other}\` и снова ${path}.`
      )
    ).toEqual([path, other]);
  });

  it("refuses dots, NUL, another directory and a name over 255 characters", async () => {
    const { namedAttachmentPaths, pathMatchesBytes } = await loadInbox();
    const root = `/workspace/attachments/${hash}`;

    expect(
      namedAttachmentPaths(
        [
          `${root}/..`,
          `${root}/...`,
          `${root}/a\0b`,
          `/tmp/workspace/attachments/${hash}/x.csv`,
          // Under a directory of another script's letters, or after a digit.
          `папка/workspace/attachments/${hash}/x.csv`,
          `2/workspace/attachments/${hash}/x.csv`,
          `/workspace/attachments/${hash}/sub/x.csv`,
          `/workspace/attachments/${hash.toUpperCase()}/x.csv`,
          `${root}/${"n".repeat(256)}`,
        ].join("\n")
      )
    ).toEqual([]);
    expect(pathMatchesBytes(`${root}/..`, bytes)).toBe(false);
    // eve's `safeFilename` does not shorten a name: a long one is still found,
    // at the end of a sentence too.
    const long = `${root}/${"n".repeat(250)}.xlsx`;
    expect(namedAttachmentPaths(`Вот файл: ${long}.`)).toEqual([long]);
    expect(pathMatchesBytes(long, bytes)).toBe(true);
  });

  it("checks the bytes against the path's hash", async () => {
    const { pathMatchesBytes } = await loadInbox();

    expect(pathMatchesBytes(path, bytes)).toBe(true);
    expect(pathMatchesBytes(path, new Uint8Array([1, 2, 4]))).toBe(false);
  });
});

describe("the inbox key", () => {
  it("is per workspace and per conversation, hiding both ids", async () => {
    const { inboxKey } = await loadInbox();

    const key = inboxKey("workspace-1", "session-1", path);
    expect(key).toMatch(
      new RegExp(
        `^sandbox/inbox/[\\da-f]{16}/[\\da-f]{16}/${hash}/report\\.xlsx$`,
        "u"
      )
    );
    expect(key).not.toContain("workspace-1");
    expect(key).not.toContain("session-1");
    expect(inboxKey("workspace-2", "session-1", path)).not.toBe(key);
    expect(inboxKey("workspace-1", "session-2", path)).not.toBe(key);
    expect(inboxKey("workspace-1", "session-1", path)).toBe(key);
    expect(() => inboxKey("workspace-1", "session-1", "/etc/passwd")).toThrow(
      /staged attachment/u
    );
  });
});

describe("the inbox in Object Storage", () => {
  it("stores and reads a file by its key", async () => {
    const calls = stubStorage(
      new Response(null, { status: 200 }),
      new Response(bytes, {
        headers: { "content-length": "3", "last-modified": storedAgo(0) },
        status: 200,
      })
    );
    const { getInbox, inboxKey, putInbox } = await loadInbox();
    const key = inboxKey("workspace-1", "session-1", path);

    await putInbox(key, bytes);
    expect(await getInbox(key)).toEqual({ bytes, kind: "file" });
    expect(calls.map((call) => call.method)).toEqual(["PUT", "GET"]);
    expect(calls[0]?.url.pathname).toBe(`/bro-state-test/${key}`);
  });

  it("answers a missing object with null and does not ask again", async () => {
    const calls = stubStorage(
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
    );
    const { getInbox, inboxKey } = await loadInbox();

    expect(await getInbox(inboxKey("w", "s", path))).toEqual({
      kind: "missing",
    });
    expect(calls).toHaveLength(1);
  });

  it("reads a missing bucket as an outage, not a missing file", async () => {
    stubStorage(
      new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 })
    );
    const { getInbox, inboxKey } = await loadInbox();

    await expect(getInbox(inboxKey("w", "s", path))).rejects.toThrow(
      /no such bucket/u
    );
  });

  it("asks once more a second after a 5xx or a broken connection", async () => {
    vi.useFakeTimers();
    const calls = stubStorage(
      new Response(null, { status: 503 }),
      new Response(bytes, {
        headers: { "last-modified": storedAgo(0) },
        status: 200,
      }),
      new TypeError("fetch failed"),
      new Response(null, { status: 200 })
    );
    const { getInbox, inboxKey, putInbox } = await loadInbox();
    const key = inboxKey("w", "s", path);

    const read = getInbox(key);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await read).toEqual({ bytes, kind: "file" });
    const write = putInbox(key, bytes);
    await vi.advanceTimersByTimeAsync(1000);
    await write;
    expect(calls.map((call) => call.method)).toEqual([
      "GET",
      "GET",
      "PUT",
      "PUT",
    ]);
  });

  it("stops waiting to ask again once the caller's deadline passes", async () => {
    vi.useFakeTimers();
    const calls = stubStorage(
      new Response(null, { status: 503 }),
      new Response(bytes, { status: 200 })
    );
    const { getInbox, inboxKey } = await loadInbox();
    const deadline = new AbortController();

    const read = getInbox(inboxKey("w", "s", path), deadline.signal);
    const settled = read.then(
      () => "read",
      () => "failed"
    );
    await vi.advanceTimersByTimeAsync(10);
    deadline.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(await Promise.race([settled, Promise.resolve("waiting")])).toBe(
      "failed"
    );
    expect(calls).toHaveLength(1);
  });

  it("gives up after the second 5xx, and at once on a refusal", async () => {
    vi.useFakeTimers();
    const calls = stubStorage(
      new Response(null, { status: 500 }),
      new Response(null, { status: 500 }),
      new Response(null, { status: 403 })
    );
    const { getInbox, inboxKey, InboxStorageError } = await loadInbox();
    const key = inboxKey("w", "s", path);

    await Promise.all([
      expect(getInbox(key)).rejects.toThrow(InboxStorageError),
      vi.advanceTimersByTimeAsync(1000),
    ]);
    await expect(getInbox(key)).rejects.toThrow(/403/u);
    expect(calls).toHaveLength(3);
  });

  it("refuses a file over 10 MB both ways", async () => {
    const calls = stubStorage(
      new Response(null, {
        headers: {
          "content-length": String(10 * 1024 * 1024 + 1),
          "last-modified": storedAgo(0),
        },
        status: 200,
      })
    );
    const { getInbox, inboxKey, putInbox } = await loadInbox();
    const key = inboxKey("w", "s", path);

    await expect(
      putInbox(key, new Uint8Array(10 * 1024 * 1024 + 1))
    ).rejects.toThrow(/10 MB/u);
    await expect(getInbox(key)).rejects.toThrow(/10 MB/u);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("takes only a file stored within the last five minutes", async () => {
    const calls = stubStorage(
      new Response(bytes, {
        headers: { "last-modified": storedAgo(4) },
        status: 200,
      }),
      new Response(bytes, {
        headers: { "last-modified": storedAgo(6) },
        status: 200,
      }),
      // An object without a readable date counts as old.
      new Response(bytes, { status: 200 }),
      new Response(bytes, {
        headers: { "last-modified": "yesterday" },
        status: 200,
      })
    );
    const { getInbox, inboxKey } = await loadInbox();
    const key = inboxKey("w", "s", path);

    expect(await getInbox(key)).toEqual({ bytes, kind: "file" });
    expect(await getInbox(key)).toEqual({ kind: "stale" });
    expect(await getInbox(key)).toEqual({ kind: "stale" });
    expect(await getInbox(key)).toEqual({ kind: "stale" });
    expect(calls).toHaveLength(4);
  });
});

describe("the mark of a sandbox that holds the person's files", () => {
  const target = {
    parentSessionId: "session-1",
    sandboxId: "sb-1",
    workspaceId: "workspace-1",
  };

  it("marks the conversation, then the sandbox, and reads both", async () => {
    const calls = stubStorage(
      new Response(null, { status: 200 }),
      new Response(null, { status: 200 }),
      new Response("1", { status: 200 }),
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
      new Response("1", { status: 200 }),
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
    );
    const {
      conversationHoldsPersonFiles,
      markSandboxHoldsPersonFiles,
      sandboxHoldsPersonFiles,
    } = await loadInbox();

    await markSandboxHoldsPersonFiles(target);
    expect(await sandboxHoldsPersonFiles("sb-1")).toBe(true);
    expect(await sandboxHoldsPersonFiles("sb-2")).toBe(false);
    expect(await conversationHoldsPersonFiles("workspace-1", "session-1")).toBe(
      true
    );
    expect(await conversationHoldsPersonFiles("workspace-1", "session-2")).toBe(
      false
    );
    const paths = calls.map((call) => `${call.method} ${call.url.pathname}`);
    expect(paths[0]).toMatch(
      /^PUT \/bro-state-test\/sandbox\/person-files-conversations\/[\da-f]{16}\/[\da-f]{16}$/u
    );
    expect(paths[0]).not.toContain("workspace-1");
    expect(paths.slice(1, 4)).toEqual([
      "PUT /bro-state-test/sandbox/person-files/sb-1",
      "GET /bro-state-test/sandbox/person-files/sb-1",
      "GET /bro-state-test/sandbox/person-files/sb-2",
    ]);
    expect(paths[4]).toBe(paths[0]?.replace("PUT", "GET"));
  });

  it("reads as unknown, not as absent, on anything but no such key", async () => {
    vi.useFakeTimers();
    stubStorage(
      new Response("<Error><Code>NoSuchBucket</Code></Error>", {
        status: 404,
      }),
      new Response(null, { status: 403 }),
      new Response(null, { status: 503 }),
      new Response(null, { status: 503 })
    );
    const { InboxStorageError, sandboxHoldsPersonFiles } = await loadInbox();

    await expect(sandboxHoldsPersonFiles("sb-1")).rejects.toThrow(
      InboxStorageError
    );
    await expect(sandboxHoldsPersonFiles("sb-1")).rejects.toThrow(/403/u);
    await Promise.all([
      expect(sandboxHoldsPersonFiles("sb-1")).rejects.toThrow(/503/u),
      vi.advanceTimersByTimeAsync(1000),
    ]);
    // An id that is not a code sandbox's is no key at all.
    await expect(sandboxHoldsPersonFiles("../x")).rejects.toThrow(
      /sandbox's id/u
    );
  });

  it("fails the mark when Object Storage refuses either object", async () => {
    const calls = stubStorage(
      new Response(null, { status: 403 }),
      new Response(null, { status: 200 }),
      new Response(null, { status: 403 })
    );
    const { markSandboxHoldsPersonFiles } = await loadInbox();

    await expect(markSandboxHoldsPersonFiles(target)).rejects.toThrow(/403/u);
    // The sandbox is not marked without its conversation.
    expect(calls).toHaveLength(1);
    await expect(markSandboxHoldsPersonFiles(target)).rejects.toThrow(/403/u);
    expect(calls).toHaveLength(3);
  });
});

function noSuchKey() {
  return new Response("<Error><Code>NoSuchKey</Code></Error>", {
    status: 404,
  });
}

describe("the person's own sends to task agents", () => {
  const start = {
    callId: "call-1",
    kind: "start",
    message: "Найди курс евро",
    turnId: "turn_3",
  } as const;
  /** The task agent's message that takes a send. */
  const taker = JSON.stringify(["session-task", "turn_0", 0]);

  it("are one object per call under the conversation's inbox, hiding the ids", async () => {
    const calls = stubStorage(
      new Response(null, { status: 200 }),
      new Response("1", {
        headers: { "last-modified": storedAgo(1) },
        status: 200,
      }),
      new Response(null, { status: 200 })
    );
    const { putPersonSend, takePersonSend } = await loadInbox();

    await putPersonSend("workspace-1", "session-1", start);
    expect(await takePersonSend("workspace-1", "session-1", start, taker)).toBe(
      true
    );
    const [put, get, claimed] = calls;
    expect(put?.method).toBe("PUT");
    expect(put?.url.pathname).toMatch(
      /^\/bro-state-test\/sandbox\/inbox\/[\da-f]{16}\/[\da-f]{16}\/calls\/[\da-f]{32}$/u
    );
    for (const id of ["call-1", "turn_3", "курс"]) {
      expect(decodeURIComponent(put?.url.pathname ?? "")).not.toContain(id);
    }
    expect(get?.url.pathname).toBe(put?.url.pathname);
    // Taken once: the record is claimed as it is taken.
    expect(claimed?.method).toBe("PUT");
    expect(claimed?.url.pathname).toBe(put?.url.pathname);
  });

  it("keep a continuation apart, under the task agent's id", async () => {
    // A call id and an agent id never name the same object, whatever they are.
    const calls = stubStorage(
      new Response(null, { status: 200 }),
      new Response(null, { status: 200 })
    );
    const { putPersonSend } = await loadInbox();

    await putPersonSend("w", "s", {
      agentId: "same",
      kind: "continue",
      message: "m",
    });
    await putPersonSend("w", "s", {
      callId: "same",
      kind: "start",
      message: "m",
      turnId: "turn_3",
    });
    const [continued, started] = calls.map((call) => call.url.pathname);
    expect(continued).toMatch(/\/agents\/[\da-f]{32}$/u);
    expect(continued).not.toContain("same");
    expect(started).toMatch(/\/calls\/[\da-f]{32}$/u);
  });

  it("name the message's text, and a start its turn too", async () => {
    // A report's turn sends the same task agent other text; a host that
    // numbers calls from `call_0` repeats the person's call id in it.
    const calls = stubStorage(
      ...Array.from({ length: 5 }, () => new Response(null, { status: 200 }))
    );
    const { putPersonSend } = await loadInbox();
    const continuation = {
      agentId: "ag_task:1",
      kind: "continue",
      message: "Добавь слайд",
    } as const;

    await putPersonSend("w", "s", start);
    await putPersonSend("w", "s", { ...start, message: "Найди курс евро " });
    await putPersonSend("w", "s", { ...start, turnId: "turn_4" });
    await putPersonSend("w", "s", continuation);
    await putPersonSend("w", "s", {
      ...continuation,
      message: "Отправь цифры",
    });
    const keys = calls.map((call) => call.url.pathname);
    expect(new Set(keys).size).toBe(5);
  });

  it("count only while stored within the last five minutes", async () => {
    stubStorage(
      new Response("1", {
        headers: { "last-modified": storedAgo(6) },
        status: 200,
      }),
      new Response("1", { status: 200 }),
      noSuchKey()
    );
    const { takePersonSend } = await loadInbox();

    expect(await takePersonSend("w", "s", start, taker)).toBe(false);
    // No date reads as old.
    expect(await takePersonSend("w", "s", start, taker)).toBe(false);
    expect(
      await takePersonSend(
        "w",
        "s",
        { agentId: "ag_task:1", kind: "continue", message: "m" },
        taker
      )
    ).toBe(false);
  });

  it("count once: another message of the task agent's finds it taken", async () => {
    const calls = stubStorage(
      new Response("1", {
        headers: { "last-modified": storedAgo(1) },
        status: 200,
      }),
      new Response(null, { status: 200 }),
      new Response(`taken:${sha256(taker)}`, {
        headers: { "last-modified": storedAgo(0) },
        status: 200,
      })
    );
    const { takePersonSend } = await loadInbox();

    expect(await takePersonSend("w", "s", start, taker)).toBe(true);
    // A report's turn sends the same text: another turn of the task agent's.
    expect(
      await takePersonSend(
        "w",
        "s",
        start,
        JSON.stringify(["session-task", "turn_1", 1])
      )
    ).toBe(false);
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET"]);
  });

  it("count again for the very message that took it, its step run again", async () => {
    // eve re-runs the step after a restart from the state before it; the
    // claim is long stale by then (14 minutes after a deploy).
    stubStorage(
      new Response(`taken:${sha256(taker)}`, {
        headers: { "last-modified": storedAgo(14) },
        status: 200,
      })
    );
    const { takePersonSend } = await loadInbox();

    expect(await takePersonSend("w", "s", start, taker)).toBe(true);
  });

  it("count as unknown when the record could not be claimed", async () => {
    stubStorage(
      new Response("1", {
        headers: { "last-modified": storedAgo(1) },
        status: 200,
      }),
      new Response(null, { status: 403 })
    );
    const { takePersonSend } = await loadInbox();

    await expect(takePersonSend("w", "s", start, taker)).rejects.toThrow(
      /403/u
    );
  });
});

describe("a sandbox kept off the web without the person's files", () => {
  it("marks the sandbox alone, never its conversation", async () => {
    const calls = stubStorage(new Response(null, { status: 200 }));
    const { markSandboxOffWeb } = await loadInbox();

    await markSandboxOffWeb("sb-1");
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "PUT /bro-state-test/sandbox/person-files/sb-1",
    ]);
  });

  it("fails when Object Storage refuses the mark", async () => {
    stubStorage(new Response(null, { status: 403 }));
    const { markSandboxOffWeb } = await loadInbox();

    await expect(markSandboxOffWeb("sb-1")).rejects.toThrow(/403/u);
  });
});

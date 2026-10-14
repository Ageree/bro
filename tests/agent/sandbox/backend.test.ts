import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

afterEach(() => {
  clearSandboxSettings();
  vi.unstubAllGlobals();
  vi.resetModules();
});

interface Call {
  readonly body: string;
  readonly method: string;
  readonly url: string;
}

/** sandboxd as a stand-in: each request gets the next answer. */
function stubHost(...answers: readonly (() => Response)[]) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({
      body: z.string().catch("").parse(init.body),
      method: init.method ?? "GET",
      url,
    });
    const answer = answers[calls.length - 1];
    if (!answer) throw new Error("The test ran out of stubbed answers.");
    return Promise.resolve(answer());
  });
  return calls;
}

const opened = () =>
  Response.json({ created: true, id: "sb", restored: false, state: "running" });

function ndjson(...events: readonly object[]) {
  const text = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  // Split mid-line: the client must join chunks before it parses a line.
  const bytes = new TextEncoder().encode(text);
  const cut = Math.floor(bytes.length / 2);
  return new Response(
    new ReadableStream({
      start: (controller) => {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } }
  );
}

async function backend() {
  return await importWithSandbox(async () => {
    const [module, keys] = await Promise.all([
      import("@agent/lib/sandbox/backend"),
      import("@agent/lib/sandbox/keys"),
    ]);
    return { ...module, keys };
  });
}

const openBody = z.object({
  snapshot: z.object({ key: z.string(), put: z.string() }),
  tools: z.object({ token: z.string(), url: z.string() }),
  workspace: z.string(),
});

const createInput = {
  existingMetadata: { sandboxId: "old", workspaceId: "personal:abc" },
  runtimeContext: { appRoot: "/app" },
  sessionKey: "session-1",
  templateKey: null,
};

/** Megabytes of output on one stream. */
const flood = (stream: "stderr" | "stdout", megabytes: number) =>
  Array.from({ length: megabytes }, () => ({
    data: Buffer.alloc(1024 * 1024, "e").toString("base64"),
    type: stream,
  }));
const text = (value: string) => Buffer.from(value).toString("base64");
/** Host events as one chunk of the command's stream. */
const lines = (...events: readonly object[]) =>
  new TextEncoder().encode(
    events.map((event) => `${JSON.stringify(event)}\n`).join("")
  );
const cutNote = (bytes: number) =>
  `\n[output cut: ${String(bytes)} bytes not kept while the reader was behind]\n`;

describe("the Cloud.ru sandbox backend", () => {
  it("opens the session's sandbox with fresh links and the router token", async () => {
    const calls = stubHost(opened);
    const { cloudRuSandbox, keys } = await backend();
    const handle = await cloudRuSandbox().create(createInput);
    const sandboxId = keys.sandboxIdFor("session-1");
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(
      `https://10-0-0-1.sslip.io/v1/sandboxes/${sandboxId}`
    );
    const body = openBody.parse(JSON.parse(calls[0]?.body ?? "{}"));
    expect(body.workspace).toBe("bro");
    expect(body.tools.url).toBe(
      "https://bro.example.test/eve/v1/sandbox-tools"
    );
    expect(keys.verifySandboxToolsToken(body.tools.token)).toMatchObject({
      sb: sandboxId,
      ws: "personal:abc",
    });
    // The task agent's hook marks the sandbox by the session's id
    // (`markSandboxHoldsPersonFiles`), and the router checks the token's.
    expect(handle.session.id).toBe(sandboxId);
    expect(body.snapshot.key).toBe(keys.sandboxSnapshotKey(sandboxId));
    expect(body.snapshot.put).toContain(
      `/bro-state-test/sandbox/workspaces/${sandboxId}.snap?`
    );
    expect(await handle.captureState()).toEqual({
      backendName: "bro-cloudru",
      metadata: { sandboxId, workspaceId: "personal:abc" },
      sessionKey: "session-1",
    });
  });

  it("asks for the memory it was given, or the host's default", async () => {
    const calls = stubHost(opened, opened);
    const { cloudRuSandbox } = await backend();

    await cloudRuSandbox({ memoryMb: 1024 }).create(createInput);
    await cloudRuSandbox().create(createInput);

    const memory = z.object({ memoryMb: z.number().optional() });
    const [small, standard] = calls.map((call) =>
      memory.parse(JSON.parse(call.body))
    );
    expect(small?.memoryMb).toBe(1024);
    expect(standard).toEqual({});
  });

  it("opens before onSession knows the workspace, then renews the token", async () => {
    const calls = stubHost(opened, opened);
    const { cloudRuSandbox, keys } = await backend();
    const handle = await cloudRuSandbox().create({
      ...createInput,
      existingMetadata: undefined,
    });
    const first = openBody.parse(JSON.parse(calls[0]?.body ?? "{}"));
    expect(first.workspace).toBe("bro");
    expect(keys.verifySandboxToolsToken(first.tools.token)?.ws).toBe("");
    await handle.useSessionFn({ workspaceId: "personal:abc" });
    const second = openBody.parse(JSON.parse(calls[1]?.body ?? "{}"));
    expect(second.workspace).toBe("bro");
    expect(keys.verifySandboxToolsToken(second.tools.token)?.ws).toBe(
      "personal:abc"
    );
    expect((await handle.captureState()).metadata).toMatchObject({
      workspaceId: "personal:abc",
    });
  });

  it("runs a command and gathers its streams", async () => {
    const calls = stubHost(opened, () =>
      ndjson(
        { pid: "p1", type: "start" },
        { data: Buffer.from("привет\n").toString("base64"), type: "stdout" },
        { data: Buffer.from("warn").toString("base64"), type: "stderr" },
        { code: 3, type: "exit" }
      )
    );
    const { cloudRuSandbox } = await backend();
    const { session } = await cloudRuSandbox().create(createInput);
    const result = await session.run({
      command: "echo привет; exit 3",
      workingDirectory: "out",
    });
    expect(result).toEqual({ exitCode: 3, stderr: "warn", stdout: "привет\n" });
    expect(z.json().parse(JSON.parse(calls[1]?.body ?? "{}"))).toMatchObject({
      command: "echo привет; exit 3",
      cwd: "/workspace/out",
    });
  });

  it("ignores the host's keepalive and keeps only the first megabyte of output", async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, "x").toString("base64");
    stubHost(opened, () =>
      ndjson(
        { pid: "p1", type: "start" },
        { type: "ping" },
        { data: big, type: "stdout" },
        { type: "ping" },
        { code: 0, type: "exit" }
      )
    );
    const { cloudRuSandbox } = await backend();
    const { session } = await cloudRuSandbox().create(createInput);
    const result = await session.run({ command: "yes | head -c 1048586" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith("x".repeat(1024 * 1024))).toBe(true);
    expect(result.stdout).toContain("[output cut: 10 more bytes not kept]");
  });

  it("pauses a command its reader is behind, and ends it once both streams are cancelled", async () => {
    // A command that never stops writing: sandboxd sends what it is given.
    let produced = 0;
    const megabyte = Buffer.alloc(1024 * 1024, "y").toString("base64");
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: (controller) => {
            produced += 1;
            const event =
              produced === 1
                ? { pid: "p1", type: "start" }
                : { data: megabyte, type: "stdout" };
            controller.enqueue(
              new TextEncoder().encode(`${JSON.stringify(event)}\n`)
            );
          },
        })
      );
    const calls = stubHost(opened, endless, () => Response.json({ ok: true }));
    const { cloudRuSandbox } = await backend();
    const { session } = await cloudRuSandbox().create(createInput);
    const process = await session.spawn({ command: "yes" });
    const exit = process.wait();
    // Held, but not read yet.
    const stdout = process.stdout.getReader();
    const stderr = process.stderr.getReader();
    await vi.waitFor(() => {
      expect(produced).toBeGreaterThan(2);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    // A megabyte waits for the reader; the host's stream is not drained.
    expect(produced).toBeLessThan(6);
    await stdout.cancel();
    await stderr.cancel();
    await expect(exit).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[2]?.url).toContain("/procs/p1/kill");
  });

  it("finishes a command whose reader reads stdout only while stderr floods", async () => {
    stubHost(opened, () =>
      ndjson(
        { pid: "p1", type: "start" },
        { data: text("начало\n"), type: "stdout" },
        ...flood("stderr", 3),
        { data: text("конец\n"), type: "stdout" },
        { code: 0, type: "exit" }
      )
    );
    const { cloudRuSandbox } = await backend();
    const { session } = await cloudRuSandbox().create(createInput);
    const process = await session.spawn({ command: "noisy" });
    const stdout = await new Response(process.stdout).text();
    expect(stdout).toBe("начало\nконец\n");
    await expect(process.wait()).resolves.toEqual({ exitCode: 0 });
    // What was kept of the unread stream, and a note where the rest went.
    const stderr = await new Response(process.stderr).text();
    expect(stderr).toBe(
      `${"e".repeat(1024 * 1024)}${cutNote(2 * 1024 * 1024)}`
    );
  });

  it("finishes a command whose reader holds both streams but reads stdout first", async () => {
    stubHost(opened, () =>
      ndjson(
        { pid: "p1", type: "start" },
        ...flood("stderr", 2),
        { data: text("готово\n"), type: "stdout" },
        ...flood("stderr", 1),
        { data: text("ещё\n"), type: "stderr" },
        { code: 0, type: "exit" }
      )
    );
    const { cloudRuSandbox } = await backend();
    const { session } = await cloudRuSandbox().create(createInput);
    const process = await session.spawn({ command: "noisy" });
    const stderrReader = process.stderr.getReader();
    expect(await new Response(process.stdout).text()).toBe("готово\n");
    await expect(process.wait()).resolves.toEqual({ exitCode: 0 });
    stderrReader.releaseLock();
    const stderr = await new Response(process.stderr).text();
    // The stream stays full until read: its late line is cut too.
    expect(stderr).toBe(
      `${"e".repeat(1024 * 1024)}${cutNote(2 * 1024 * 1024 + 7)}`
    );
  });

  it("pauses for a slow stderr reader once stdout's waiting reader cancelled", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    stubHost(
      opened,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              await gate;
              controller.enqueue(
                lines(...flood("stderr", 3), { code: 0, type: "exit" })
              );
              controller.close();
            },
            start: (controller) => {
              controller.enqueue(lines({ pid: "p1", type: "start" }));
            },
          })
        )
    );
    const { cloudRuSandbox } = await backend();
    const { session } = await cloudRuSandbox().create(createInput);
    const process = await session.spawn({ command: "noisy" });
    const stdout = process.stdout.getReader();
    const waiting = stdout.read();
    await stdout.cancel();
    await expect(waiting).resolves.toMatchObject({ done: true });
    // Held, and read only once the command is well past a megabyte.
    const held = process.stderr.getReader();
    open();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    held.releaseLock();
    const stderr = await new Response(process.stderr).text();
    expect(stderr).not.toContain("[output cut");
    expect(stderr).toHaveLength(3 * 1024 * 1024);
    await expect(process.wait()).resolves.toEqual({ exitCode: 0 });
  });

  it("finishes a command whose caller only waits for its exit", async () => {
    stubHost(opened, () =>
      ndjson(
        { pid: "p1", type: "start" },
        ...flood("stdout", 2),
        ...flood("stderr", 2),
        { code: 7, type: "exit" }
      )
    );
    const { cloudRuSandbox } = await backend();
    const { session } = await cloudRuSandbox().create(createInput);
    const process = await session.spawn({ command: "noisy" });
    await expect(process.wait()).resolves.toEqual({ exitCode: 7 });
  });

  it("deletes the saved /workspace with the sandbox", async () => {
    const calls = stubHost(
      opened,
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 204 })
    );
    const { cloudRuSandbox, keys } = await backend();
    const handle = await cloudRuSandbox().create(createInput);
    await handle.delete();
    const sandboxId = keys.sandboxIdFor("session-1");
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[2]?.method).toBe("DELETE");
    expect(calls[2]?.url).toContain(
      `/bro-state-test/sandbox/workspaces/${sandboxId}.snap?`
    );
  });

  it("reads a missing file as null and anchors relative paths in /workspace", async () => {
    const calls = stubHost(
      opened,
      () => Response.json({ error: "not_found" }, { status: 404 }),
      () => new Response("a\nb\nc\n")
    );
    const { cloudRuSandbox, resolveSandboxPath } = await backend();
    const { session } = await cloudRuSandbox().create(createInput);
    expect(await session.readTextFile({ path: "nope.txt" })).toBeNull();
    expect(
      await session.readTextFile({ endLine: 2, path: "/tmp/x", startLine: 2 })
    ).toBe("b");
    expect(new URL(calls[1]?.url ?? "").searchParams.get("path")).toBe(
      "/workspace/nope.txt"
    );
    expect(resolveSandboxPath("./a/b")).toBe("/workspace/a/b");
    expect(resolveSandboxPath("/etc/hosts")).toBe("/etc/hosts");
  });

  it("allows no network but none", async () => {
    stubHost(opened, () => new Response(null, { status: 204 }));
    const { cloudRuSandbox } = await backend();
    const { session } = await cloudRuSandbox().create(createInput);
    await expect(session.setNetworkPolicy("allow-all")).rejects.toThrow(
      "only deny-all"
    );
    await expect(session.setNetworkPolicy("deny-all")).resolves.toBeUndefined();
  });

  it("is made during the build without the host's settings", async () => {
    const { cloudRuSandbox } = await importWithSandbox(
      async () => await import("@agent/lib/sandbox/backend"),
      { SANDBOX_HOST_ID: "", SANDBOX_HOST_ORIGIN: "", SANDBOX_SIGNING_KEY: "" }
    );
    const sandbox = cloudRuSandbox();
    await expect(
      sandbox.prewarm({
        runtimeContext: { appRoot: "/app" },
        seedFiles: [],
        templateKey: "t",
      })
    ).resolves.toEqual({ reused: true });
    await expect(sandbox.create(createInput)).rejects.toThrow("not configured");
  });
});

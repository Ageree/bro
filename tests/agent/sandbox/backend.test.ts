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

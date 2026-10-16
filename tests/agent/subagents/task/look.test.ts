import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prompt } from "@agent/lib/model/prompt";

const pilot = vi.hoisted(() => ({
  taskFilesOfCaller: vi.fn<() => boolean>(() => true),
  taskKitRouted: vi.fn<() => boolean>(() => false),
}));
vi.mock("@agent/lib/sandbox/pilot", () => pilot);

import { toolImagesMiddleware } from "@agent/lib/model/tool-images";
import look from "@agent/subagents/task/tools/look";

type SandboxSession = Awaited<ReturnType<ToolContext["getSandbox"]>>;

const resolveContext = {
  channel: { kind: "subagent", metadata: {} },
  messages: [],
  model: null,
  session: {
    auth: {
      current: {
        attributes: { workspaceId: "personal:workspace" },
        authenticator: "telegram-webhook",
        principalId: "user-1",
        principalType: "user",
      },
      initiator: null,
    },
    id: "session-task",
  },
} satisfies DynamicResolveContext;

async function resolveLook() {
  const resolve = look.events["turn.started"];
  if (!resolve) throw new Error("look resolves per turn.");
  return await resolve({}, resolveContext);
}

async function lookTool() {
  const tool = await resolveLook();
  if (!tool || !("execute" in tool)) throw new Error("Expected look.");
  return tool;
}

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** A task sandbox whose kit answers `stdout` and holds `files`. */
function sandboxWith(
  stdout: string,
  files: ReadonlyMap<string, Uint8Array>,
  exitCode = 0
) {
  const run = vi.fn<
    (options: {
      readonly env?: Record<string, string>;
    }) => Promise<{ exitCode: number; stderr: string; stdout: string }>
  >(async () =>
    Promise.resolve({
      exitCode,
      stderr: exitCode === 0 ? "" : "brokit: refused",
      stdout,
    })
  );
  const session: Pick<
    SandboxSession,
    "readFile" | "removePath" | "run" | "writeTextFile"
  > = {
    readFile: async ({ path }) => {
      const bytes = files.get(path);
      return Promise.resolve(
        bytes === undefined
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            })
      );
    },
    removePath: async () => Promise.resolve(),
    run,
    writeTextFile: async () => Promise.resolve(),
  };
  return { run, session };
}

function toolContext(sandbox: ReturnType<typeof sandboxWith>) {
  return {
    abortSignal: new AbortController().signal,
    callId: "call:look/1",
    async getSandbox() {
      // SAFETY: look runs the kit, reads its pictures and removes its directory.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial sandbox stands in for eve's.
      return await Promise.resolve(sandbox.session as SandboxSession);
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    async getToken() {
      throw new Error("Token access is outside this focused test.");
    },
    requireAuth() {
      throw new Error("Authorization is outside this focused test.");
    },
    session: {
      ...resolveContext.session,
      turn: { id: "turn_0", sequence: 0 },
    },
    toolName: "look",
  } satisfies ToolContext;
}

/** What `brokit look` prints for one PDF page with a text layer. */
function lookOutput(file: string) {
  return `${JSON.stringify({
    items: [
      {
        images: [
          {
            bytes: jpeg.byteLength,
            file,
            grid_step: null,
            height: 1280,
            page: 2,
            region: null,
            scale: 1.52,
            text_chars: 900,
            view: { height: 841.89, width: 595.28 },
            width: 906,
          },
        ],
        kind: "pdf",
        pages_total: 3,
        path: "/workspace/attachments/0123456789abcdef/act.pdf",
        unit: "pt",
      },
    ],
    next: null,
    ok: true,
    truncated: false,
    warnings: [],
  })}\n`;
}

const picture = "/workspace/.bro/look/call_look_1/1-p2.jpg";

beforeEach(() => {
  vi.clearAllMocks();
  pilot.taskFilesOfCaller.mockReturnValue(true);
});

describe("the task agent's look", () => {
  it("takes a region of zeros for no region", async () => {
    // GPT-6.1 Sol fills every optional field: «0,0,0,0» on its first look at every photo (16.10).
    const tool = await lookTool();
    const sandbox = sandboxWith(
      lookOutput(picture),
      new Map([[picture, jpeg]])
    );

    await tool.execute(
      {
        paths: ["attachments/0123456789abcdef/act.pdf"],
        region: "0,0,0,0",
      },
      toolContext(sandbox)
    );

    expect(
      JSON.parse(sandbox.run.mock.lastCall?.[0].env?.BROKIT_ARGS ?? "")
    ).not.toContain("--region");
  });

  it("is not there where the person's files do not reach the task agent", async () => {
    pilot.taskFilesOfCaller.mockReturnValue(false);

    expect(await resolveLook()).toBeNull();
  });

  it("keeps the picture out of its result and resolves its marker in the prompt", async () => {
    const tool = await lookTool();
    const sandbox = sandboxWith(
      lookOutput(picture),
      new Map([[picture, jpeg]])
    );

    const output = await tool.execute(
      { paths: ["attachments/0123456789abcdef/act.pdf"], pages: "2" },
      toolContext(sandbox)
    );
    if (Symbol.asyncIterator in output) throw new Error("Expected a result.");

    const base64 = Buffer.from(jpeg).toString("base64");
    expect(JSON.stringify(output)).not.toContain(base64);
    expect(
      JSON.parse(sandbox.run.mock.lastCall?.[0].env?.BROKIT_ARGS ?? "")
    ).toEqual([
      "look",
      "/workspace/attachments/0123456789abcdef/act.pdf",
      "--out",
      "/workspace/.bro/look/call_look_1",
      "--pages",
      "2",
    ]);

    const modelOutput = await tool.toModelOutput?.(output);
    if (modelOutput?.type !== "content") throw new Error("Expected content.");
    const texts = modelOutput.value.map((part) =>
      part.type === "text" ? part.text : part.type
    );
    expect(texts).toHaveLength(3);
    expect(texts[0]).toMatch(/^\{"items":\[/u);
    expect(texts[0]).toContain("brokit pdf text");
    expect(texts[1]).toBe("Снимок: act.pdf стр. 2");
    expect(texts[2]).toMatch(/^\[bro-look-image:[\da-f-]{36}\|2\|/u);

    const prompt: Prompt = [
      {
        content: [
          {
            input: { paths: ["act.pdf"] },
            toolCallId: "call-look",
            toolName: "look",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "content", value: [...modelOutput.value] },
            toolCallId: "call-look",
            toolName: "look",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];
    const params = await toolImagesMiddleware({
      sessionId: "session-task",
    }).transformParams?.({
      // SAFETY: the middleware reads the prompt alone.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial model stands in for the wrapped one.
      model: {} as never,
      params: { prompt },
      type: "generate",
    });
    expect(params?.prompt[2]).toMatchObject({
      content: [
        { type: "text" },
        { data: { data: base64, type: "data" }, mediaType: "image/jpeg" },
      ],
      role: "user",
    });
  });

  it("passes the kit's refusal on with its hint", async () => {
    const tool = await lookTool();
    const sandbox = sandboxWith(
      '{"ok":false,"code":"not_found","error":"no such file: /workspace/a.pdf","hint":"files there: b.pdf"}\n',
      new Map(),
      2
    );

    await expect(
      tool.execute({ paths: ["/workspace/a.pdf"] }, toolContext(sandbox))
    ).rejects.toThrow("no such file: /workspace/a.pdf — files there: b.pdf");
  });

  it("refuses a picture larger than the kit ever makes", async () => {
    const tool = await lookTool();
    const sandbox = sandboxWith(
      lookOutput(picture),
      new Map([[picture, new Uint8Array(700_000)]])
    );

    await expect(
      tool.execute(
        { paths: ["/workspace/attachments/0123456789abcdef/act.pdf"] },
        toolContext(sandbox)
      )
    ).rejects.toThrow("too large");
  });

  it("reads only the pictures of its own directory", async () => {
    const tool = await lookTool();
    const token = "/workspace/.bro/mark-token";
    const sandbox = sandboxWith(
      lookOutput(token),
      new Map([[token, new Uint8Array([1, 2, 3])]])
    );

    await expect(
      tool.execute({ paths: ["/workspace/act.pdf"] }, toolContext(sandbox))
    ).rejects.toThrow("outside its directory");
  });

  it("reads under /workspace and /tmp only", async () => {
    const tool = await lookTool();
    const sandbox = sandboxWith("", new Map());

    for (const path of ["/etc/passwd", "/workspace/../etc/passwd"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each path is refused in turn.
      await expect(
        tool.execute({ paths: [path] }, toolContext(sandbox))
      ).rejects.toThrow("under /workspace or /tmp only");
    }
    expect(sandbox.run).not.toHaveBeenCalled();
  });
});

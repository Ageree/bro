import type {
  OpenRouterChatSettings,
  OpenRouterProviderSettings,
} from "@openrouter/ai-sdk-provider";
import { generateText, streamText, tool, wrapLanguageModel } from "ai";
import {
  convertArrayToReadableStream,
  convertReadableStreamToArray,
  MockLanguageModelV4,
} from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const openRouter = vi.hoisted(() => {
  const chat =
    vi.fn<
      (modelId: string, settings: OpenRouterChatSettings) => { modelId: string }
    >();
  return {
    chat,
    createOpenRouter:
      vi.fn<(options: OpenRouterProviderSettings) => { chat: typeof chat }>(),
  };
});

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: openRouter.createOpenRouter,
}));

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  OPENROUTER_API_KEY: "openrouter-test-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  openRouter.createOpenRouter.mockReturnValue({ chat: openRouter.chat });
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("MODEL_PROVIDER", "openrouter");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const page = "/workspace/outres/zayavlenie_otpusk_zapolneno-1.png";

/** The task agent's text in f-flat-scan-otpusk-overlay, 16.10: two looks. */
const twoLooks = [
  "\n\n",
  "<｜DSML｜ calls>",
  '<｜DSML｜ invoke name="look">',
  '<｜DSML｜ parameter name="grid" string="false">true</｜DSML｜ parameter>',
  '<｜DSML｜ parameter name="note" string="true">header after space fix</｜DSML｜ parameter>',
  `<｜DSML｜ parameter name="paths" string="false">["${page}"]</｜DSML｜ parameter>`,
  '<｜DSML｜ parameter name="region" string="false">820,340,1560,580</｜DSML｜ parameter>',
  "</｜DSML｜ invoke>",
  '<｜DSML｜ invoke name="look">',
  '<｜DSML｜ parameter name="note" string="true">full page final</｜DSML｜ parameter>',
  `<｜DSML｜ parameter name="paths" string="false">["${page}"]</｜DSML｜ parameter>`,
  "</｜DSML｜ invoke>",
  "</｜DSML｜ calls>",
].join("\n");

/** The same run, the helper continued: one look. */
const oneLook = [
  "<｜DSML｜ calls>",
  '<｜DSML｜ invoke name="look">',
  '<｜DSML｜ parameter name="note" string="true">final header check</｜DSML｜ parameter>',
  `<｜DSML｜ parameter name="paths" string="false">["${page}"]</｜DSML｜ parameter>`,
  '<｜DSML｜ parameter name="region" string="false">820,340,1560,580</｜DSML｜ parameter>',
  "</｜DSML｜ invoke>",
  "</｜DSML｜ calls>",
].join("\n");

/** The task agent's tools, `look` with its own input schema. */
const tools = {
  bash: tool({ inputSchema: z.object({ command: z.string() }) }),
  look: tool({
    inputSchema: z.object({
      grid: z.boolean().optional(),
      note: z.string().max(200).optional(),
      pages: z.string().optional(),
      paths: z.array(z.string().min(1)).min(1).max(4),
      region: z
        .string()
        .regex(/^\d+(\.\d+)?(,\d+(\.\d+)?){3}$/)
        .optional(),
    }),
  }),
};

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 10,
    total: 10,
  },
  outputTokens: { reasoning: undefined, text: 10, total: 10 },
};
const stop = { raw: "stop", unified: "stop" } as const;
const cutShort = { raw: "length", unified: "length" } as const;

/** A model whose step writes `chunks` as its text, one delta each. */
function writing(
  chunks: readonly string[],
  finishReason: typeof stop | typeof cutShort = stop
) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ text: chunks.join(""), type: "text" as const }],
      finishReason,
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: convertArrayToReadableStream(streamOf(chunks, finishReason)),
    }),
  });
}

function streamOf(
  chunks: readonly string[],
  finishReason: typeof stop | typeof cutShort = stop
) {
  return [
    { type: "stream-start" as const, warnings: [] },
    { id: "t", type: "text-start" as const },
    ...chunks.map((delta) => ({ delta, id: "t", type: "text-delta" as const })),
    { id: "t", type: "text-end" as const },
    { finishReason, type: "finish" as const, usage },
  ];
}

/** A step that may call `look`, as the model is asked it. */
function lookStep(): Parameters<MockLanguageModelV4["doStream"]>[0] {
  return {
    prompt: [],
    tools: [
      { inputSchema: { type: "object" }, name: "look", type: "function" },
    ],
  };
}

/** The parts the middleware streams on for a `look` step of `model`. */
async function streamedParts(model: MockLanguageModelV4) {
  const { stream } = await (await wrapped(model)).doStream(lookStep());
  return convertReadableStreamToArray(stream);
}

/** A block of DSML calls: `look` once for each of `notes`. */
function looksAt(notes: readonly string[]) {
  return [
    "<｜DSML｜ calls>",
    ...notes.map((note) =>
      [
        '<｜DSML｜ invoke name="look">',
        `<｜DSML｜ parameter name="note" string="true">${note}</｜DSML｜ parameter>`,
        "</｜DSML｜ invoke>",
      ].join("\n")
    ),
    "</｜DSML｜ calls>",
  ].join("\n");
}

/** `text` cut into deltas of `size` characters. */
function chunked(text: string, size: number) {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) {
    chunks.push(text.slice(at, at + size));
  }
  return chunks;
}

async function middleware() {
  const { dsmlToolCallsMiddleware } = await import("@agent/lib/model/dsml");
  return dsmlToolCallsMiddleware();
}

async function wrapped(model: MockLanguageModelV4) {
  return wrapLanguageModel({ middleware: await middleware(), model });
}

function callsOf(
  toolCalls: readonly { readonly input: unknown; readonly toolName: string }[]
) {
  return toolCalls.map(({ input, toolName }) => ({ input, toolName }));
}

const twoLookCalls = [
  {
    input: {
      grid: true,
      note: "header after space fix",
      paths: [page],
      region: "820,340,1560,580",
    },
    toolName: "look",
  },
  { input: { note: "full page final", paths: [page] }, toolName: "look" },
];

const oneLookCall = [
  {
    input: {
      note: "final header check",
      paths: [page],
      region: "820,340,1560,580",
    },
    toolName: "look",
  },
];

describe("DeepSeek's tool-call markup in the text", () => {
  it.each([
    ["two looks after blank lines", twoLooks, twoLookCalls],
    ["one look", oneLook, oneLookCall],
  ])(
    "turns a real block into the calls it names: %s",
    async (_, text, calls) => {
      const generated = await generateText({
        model: await wrapped(writing([text])),
        prompt: "check the page",
        tools,
      });

      expect(callsOf(generated.toolCalls)).toEqual(calls);
      expect(generated.text).toBe("");
      expect(generated.finishReason).toBe("tool-calls");
      expect(
        generated.content.filter((part) => part.type === "tool-error")
      ).toEqual([]);
      expect(
        new Set(generated.toolCalls.map((call) => call.toolCallId)).size
      ).toBe(calls.length);
    }
  );

  it("finds a block split across stream chunks, with the text before it streamed", async () => {
    const lead = "Проверяю шапку, <b>жирным</b> не нужно.\n";
    const model = await wrapped(writing(chunked(lead + twoLooks, 1)));
    const { stream } = await model.doStream({
      prompt: [],
      tools: [
        { inputSchema: { type: "object" }, name: "look", type: "function" },
      ],
    });
    const parts = await convertReadableStreamToArray(stream);
    const firstCall = parts.findIndex((part) => part.type === "tool-call");
    const streamed = streamText({
      model: await wrapped(writing(chunked(twoLooks, 5))),
      prompt: "check the page",
      tools,
    });

    expect(
      parts
        .slice(0, firstCall)
        .flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
        .join("")
    ).toBe(`${lead}\n\n\n`);
    expect(
      parts.flatMap((part) =>
        part.type === "tool-call"
          ? [
              {
                input: z.json().parse(JSON.parse(part.input)),
                toolName: part.toolName,
              },
            ]
          : []
      )
    ).toEqual(twoLookCalls);
    expect(parts.at(-1)).toMatchObject({
      finishReason: { unified: "tool-calls" },
      type: "finish",
    });
    expect(callsOf(await streamed.toolCalls)).toEqual(twoLookCalls);
    expect((await streamed.text).trim()).toBe("");
    expect(await streamed.finishReason).toBe("tool-calls");
  });

  it("passes a step whose text has no markup on as it was", async () => {
    const plain = ["Готово: ", "a < b, <i>курсив</i>", " и | конец"];
    const sent = streamOf(plain);
    const model = await wrapped(
      new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ text: plain.join(""), type: "text" as const }],
          finishReason: stop,
          usage,
          warnings: [],
        }),
        doStream: async () => ({ stream: convertArrayToReadableStream(sent) }),
      })
    );
    const call: Parameters<typeof model.doGenerate>[0] = {
      prompt: [],
      tools: [
        { inputSchema: { type: "object" }, name: "look", type: "function" },
      ],
    };
    const generated = await model.doGenerate(call);
    const passed = await convertReadableStreamToArray(
      (await model.doStream(call)).stream
    );
    // A `<` and a bar in separate chunks are held together, then let go.
    const held = await convertReadableStreamToArray(
      (await (await wrapped(writing(["и ", "<", "| конец"]))).doStream(call))
        .stream
    );

    expect(generated.content).toEqual([{ text: plain.join(""), type: "text" }]);
    expect(generated.finishReason).toEqual(stop);
    expect(passed).toHaveLength(sent.length);
    for (const [index, part] of passed.entries()) {
      expect(part).toBe(sent[index]);
    }
    expect(
      held.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
    ).toEqual(["и ", "<| конец"]);
    expect(held.at(-1)).toMatchObject({ finishReason: stop, type: "finish" });
  });

  it.each([
    [
      "only an unknown tool",
      oneLook.replace('name="look"', 'name="delete_everything"'),
    ],
    [
      "a known and an unknown tool",
      twoLooks.replace(
        '<｜DSML｜ invoke name="look">\n<｜DSML｜ parameter name="note" string="true">full',
        '<｜DSML｜ invoke name="share_file">\n<｜DSML｜ parameter name="note" string="true">full'
      ),
    ],
  ])(
    "keeps the markup as text when it names a tool the step lacks: %s",
    async (_, text) => {
      const generated = await generateText({
        model: await wrapped(writing([text])),
        prompt: "check the page",
        tools,
      });
      const streamed = streamText({
        model: await wrapped(writing(chunked(text, 4))),
        prompt: "check the page",
        tools,
      });

      expect(generated.toolCalls).toEqual([]);
      expect(generated.text).toBe(text);
      expect(generated.finishReason).toBe("stop");
      expect(await streamed.toolCalls).toEqual([]);
      expect(await streamed.text).toBe(text);
    }
  );

  it("leaves a step that may call no tool to the middleware that drops calls", async () => {
    const generated = await generateText({
      model: await wrapped(writing([oneLook])),
      prompt: "check the page",
      toolChoice: "none",
      tools,
    });

    expect(generated.toolCalls).toEqual([]);
    expect(generated.text).toBe(oneLook);
  });

  it("is part of a DeepSeek model's selection, not of a step told to call none", async () => {
    const { directModelSelection } = await import("@agent/lib/model/direct");
    openRouter.chat.mockReturnValue(writing([oneLook]));
    const free = directModelSelection("deepseek/deepseek-v4.1-flash", {
      toolChoice: "auto",
    });
    const quiet = directModelSelection("deepseek/deepseek-v4.1-flash", {
      toolChoice: "none",
    });

    const called = await generateText({
      model: free.model,
      prompt: "check the page",
      tools,
    });
    const ended = await generateText({
      model: quiet.model,
      prompt: "check the page",
      tools,
    });

    expect(callsOf(called.toolCalls)).toEqual(oneLookCall);
    expect(ended.toolCalls).toEqual([]);
    expect(ended.text).toBe(oneLook);
  });

  it("lets a block that never closes go on whole when its text ends", async () => {
    const lead = "Сейчас посмотрю.\n";
    const open = looksAt(["шапка"]).replace("</｜DSML｜ calls>", "");
    const parts = await streamedParts(writing(chunked(lead + open, 3)));
    const end = parts.findIndex((part) => part.type === "text-end");

    expect(parts.filter((part) => part.type === "tool-call")).toEqual([]);
    expect(
      parts
        .flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
        .join("")
    ).toBe(lead + open);
    expect(parts[end - 1]).toEqual({
      delta: open,
      id: "t",
      type: "text-delta",
    });
    expect(parts.at(-1)).toMatchObject({ finishReason: stop, type: "finish" });
  });

  it("keeps the finish reason of a step cut short, with the calls of its whole block", async () => {
    const model = await wrapped(writing([oneLook], cutShort));
    const generated = await model.doGenerate(lookStep());
    const parts = await streamedParts(writing(chunked(oneLook, 7), cutShort));

    expect(generated.content.map((part) => part.type)).toEqual(["tool-call"]);
    expect(generated.finishReason).toEqual(cutShort);
    expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(1);
    expect(parts.at(-1)).toMatchObject({
      finishReason: cutShort,
      type: "finish",
    });
  });

  it("reads a long block once, not again on every delta", async () => {
    const note = "a < b > c ".repeat(20_000);
    const chunks = chunked(looksAt([note]), 4);

    const started = performance.now();
    const parts = await streamedParts(writing(chunks));
    const took = performance.now() - started;

    // Read again on every delta, it took about 9 s here.
    expect(took).toBeLessThan(300);
    expect(
      parts.flatMap((part) =>
        part.type === "tool-call"
          ? [z.json().parse(JSON.parse(part.input))]
          : []
      )
    ).toEqual([{ note }]);
  });

  it("keeps a block with more calls than a step makes as text", async () => {
    const notes = Array.from({ length: 64 }, (_, index) => String(index));
    const most = await (
      await wrapped(writing([looksAt(notes)]))
    ).doGenerate(lookStep());
    const tooMany = await (
      await wrapped(writing([looksAt([...notes, "64"])]))
    ).doGenerate(lookStep());

    expect(
      most.content.filter((part) => part.type === "tool-call")
    ).toHaveLength(64);
    expect(tooMany.content).toEqual([
      { text: looksAt([...notes, "64"]), type: "text" },
    ]);
  });

  it("lets the text it holds go before a call the host made itself", async () => {
    const hostCall = {
      input: "{}",
      toolCallId: "host_0",
      toolName: "look",
      type: "tool-call" as const,
    };
    const parts = await streamedParts(
      new MockLanguageModelV4({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: "stream-start" as const, warnings: [] },
            { id: "t", type: "text-start" as const },
            { delta: "Сейчас ", id: "t", type: "text-delta" as const },
            { delta: "<｜DSML｜ func", id: "t", type: "text-delta" as const },
            hostCall,
            { id: "t", type: "text-end" as const },
            { finishReason: stop, type: "finish" as const, usage },
          ]),
        }),
      })
    );

    expect(
      parts.flatMap((part) =>
        part.type === "text-delta"
          ? [part.delta]
          : part.type === "tool-call"
            ? [part.toolCallId]
            : []
      )
    ).toEqual(["Сейчас ", "<｜DSML｜ func", "host_0"]);
  });
});

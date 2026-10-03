import type {
  OpenRouterChatSettings,
  OpenRouterProviderSettings,
} from "@openrouter/ai-sdk-provider";
import {
  asSchema,
  generateText,
  type JSONSchema7,
  streamText,
  tool,
  type wrapLanguageModel,
} from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

type LanguageModelV4 = ReturnType<typeof wrapLanguageModel>;

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

/**
 * `send_message` with keys in the order its zod schema lists them: `text`
 * before `kind`, and `id` before `kind` in each `replyTo` branch with one.
 */
const sendMessageSchema: JSONSchema7 = {
  properties: {
    text: { type: "string" },
    kind: { const: "message", type: "string" },
    replyTo: {
      oneOf: [
        {
          properties: { kind: { const: "current", type: "string" } },
          type: "object",
        },
        {
          properties: {
            id: { type: "string" },
            kind: { const: "task", type: "string" },
          },
          type: "object",
        },
        {
          properties: {
            id: { type: "string" },
            kind: { enum: ["automation"], type: "string" },
          },
          type: "object",
        },
      ],
    },
  },
  type: "object",
};

const sendMessageTool = {
  inputSchema: sendMessageSchema,
  name: "send_message",
  type: "function" as const,
};

function patterned(pattern: string) {
  return { pattern, type: "string" as const };
}

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  openRouter.chat.mockImplementation((modelId) => ({ modelId }));
  openRouter.createOpenRouter.mockReturnValue({ chat: openRouter.chat });
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  for (const name of [
    "MODEL_PROVIDER",
    "OPENROUTER_MODEL_CONTEXT_TOKENS",
    "OPENROUTER_PROVIDER_ORDER",
    "OPENROUTER_REASONING_EFFORT",
    "ROUTERAI_API_KEY",
    "ROUTERAI_PROVIDER_IGNORE",
    "ROUTERAI_PROVIDER_ORDER",
    "ROUTERAI_REASONING_EFFORT",
    "USAGE_USD_RUB",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("model selection", () => {
  it("keeps the gateway model id when no OpenRouter key is configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const { modelSelection } = await import("@agent/lib/model/selection");

    expect(modelSelection("openai/gpt-5.6-sol-fast")).toBe(
      "openai/gpt-5.6-sol-fast"
    );
    expect(openRouter.createOpenRouter).not.toHaveBeenCalled();
  });

  it("returns a direct OpenRouter model with an explicit context window", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "  openrouter-test-key\n");
    vi.stubEnv("OPENROUTER_MODEL_CONTEXT_TOKENS", "163840");

    const { modelSelection } = await import("@agent/lib/model/selection");
    const selection = modelSelection("deepseek/deepseek-v4.1-flash");

    const { watchedModelFetch } =
      await import("@agent/lib/model/stream-watchdog");
    expect(openRouter.createOpenRouter).toHaveBeenCalledExactlyOnceWith({
      apiKey: "openrouter-test-key",
      baseURL: "https://openrouter.ai/api/v1",
      // Every call goes through the stall watchdog.
      fetch: watchedModelFetch,
      headers: {
        "HTTP-Referer": "https://openinstinct.example",
        "X-Title": "Bro",
      },
    });
    // Hosts that decode tool calls in schema key order, or break them.
    expect(openRouter.chat).toHaveBeenCalledExactlyOnceWith(
      "deepseek/deepseek-v4.1-flash",
      {
        provider: {
          ignore: [
            "alibaba",
            "morph",
            "wafer",
            "sail-research",
            "modal",
            "parasail",
            "phala",
            "inference-net",
            "open-inference",
          ],
        },
      }
    );
    expect(selection).toMatchObject({
      model: { modelId: "deepseek/deepseek-v4.1-flash" },
      modelContextWindowTokens: 163_840,
      modelOptions: {
        providerOptions: { openrouter: { reasoning: { effort: "low" } } },
      },
    });
  });

  it("still disables reasoning when explicitly set to off", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("OPENROUTER_REASONING_EFFORT", "off");

    const { modelSelection } = await import("@agent/lib/model/selection");
    expect(modelSelection("deepseek/deepseek-v4.1-flash")).toMatchObject({
      modelOptions: {
        providerOptions: { openrouter: { reasoning: { enabled: false } } },
      },
    });
  });

  it("makes a step that must reach the person call a tool", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>();
    openRouter.chat.mockImplementation((modelId) => ({
      doGenerate,
      doStream: vi.fn<LanguageModelV4["doStream"]>(),
      modelId,
      provider: "openrouter.chat",
      specificationVersion: "v4",
      supportedUrls: {},
    }));

    const { directModelSelection } = await import("@agent/lib/model/direct");
    const selection = directModelSelection("deepseek/deepseek-v4.1-flash", {
      toolChoice: "required",
    });
    const sendMessage = {
      inputSchema: { type: "object" },
      name: "send_message",
      type: "function",
    } as const;
    await selection.model.doGenerate({ prompt: [], tools: [sendMessage] });
    await selection.model.doGenerate({ prompt: [] });

    expect(selection.model.modelId).toBe("deepseek/deepseek-v4.1-flash");
    expect(doGenerate.mock.calls[0]?.[0]).toMatchObject({
      toolChoice: { type: "required" },
    });
    // Compaction calls carry no tools, and `required` would reject them.
    expect(doGenerate.mock.calls[1]?.[0].toolChoice).toBeUndefined();
  });

  it("ends every step's prompt with the reply note", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>();
    openRouter.chat.mockImplementation((modelId) => ({
      doGenerate,
      doStream: vi.fn<LanguageModelV4["doStream"]>(),
      modelId,
      provider: "openrouter.chat",
      specificationVersion: "v4",
      supportedUrls: {},
    }));

    const { directModelSelection } = await import("@agent/lib/model/direct");
    const selection = directModelSelection("deepseek/deepseek-v4.1-flash", {
      replyNote: "Reply language for this turn: English.",
      toolChoice: "auto",
    });
    const sendMessage = {
      inputSchema: { type: "object" },
      name: "send_message",
      type: "function",
    } as const;
    const person = {
      content: [{ text: "find a dinner spot", type: "text" as const }],
      role: "user" as const,
    };
    await selection.model.doGenerate({
      prompt: [person],
      tools: [sendMessage],
    });
    await selection.model.doGenerate({ prompt: [person] });

    const prompt = doGenerate.mock.calls[0]?.[0].prompt ?? [];
    expect(prompt).toHaveLength(2);
    expect(prompt.at(-1)).toMatchObject({ role: "system" });
    expect(JSON.stringify(prompt.at(-1))).toContain("English");
    expect(doGenerate.mock.calls[0]?.[0].toolChoice).toBeUndefined();
    // Compaction writes nothing to the person and keeps its prompt.
    expect(doGenerate.mock.calls[1]?.[0].prompt).toEqual([person]);
  });

  it("takes a withheld tool out of the step and leaves compaction alone", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>();
    openRouter.chat.mockImplementation((modelId) => ({
      doGenerate,
      doStream: vi.fn<LanguageModelV4["doStream"]>(),
      modelId,
      provider: "openrouter.chat",
      specificationVersion: "v4",
      supportedUrls: {},
    }));

    const { directModelSelection } = await import("@agent/lib/model/direct");
    const selection = directModelSelection("openai/gpt-6-luna", {
      toolChoice: "required",
      withheldTools: ["ask_question"],
    });
    const tools = ["ask_question", "send_message"].map((name) => ({
      inputSchema: { type: "object" } as const,
      name,
      type: "function" as const,
    }));
    await selection.model.doGenerate({ prompt: [], tools });
    await selection.model.doGenerate({ prompt: [] });

    expect(
      doGenerate.mock.calls[0]?.[0].tools?.map(({ name }) => name)
    ).toEqual(["send_message"]);
    expect(doGenerate.mock.calls[0]?.[0]).toMatchObject({
      toolChoice: { type: "required" },
    });
    expect(doGenerate.mock.calls[1]?.[0].tools).toBeUndefined();
  });

  it("forwards toolChoice none, even for Anthropic with reasoning on", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("OPENROUTER_REASONING_EFFORT", "medium");
    const doGenerate = vi
      .fn<LanguageModelV4["doGenerate"]>()
      .mockResolvedValue({
        content: [],
        finishReason: { raw: "stop", unified: "stop" },
        usage: {
          inputTokens: {
            cacheRead: undefined,
            cacheWrite: undefined,
            noCache: 1,
            total: 1,
          },
          outputTokens: { reasoning: undefined, text: 0, total: 0 },
        },
        warnings: [],
      });
    openRouter.chat.mockImplementation((modelId) => ({
      doGenerate,
      doStream: vi.fn<LanguageModelV4["doStream"]>(),
      modelId,
      provider: "openrouter.chat",
      specificationVersion: "v4",
      supportedUrls: {},
    }));

    const { directModelSelection } = await import("@agent/lib/model/direct");
    // Anthropic's extended thinking allows tool_choice auto and none and
    // rejects only a forced tool, so `none` is not downgraded like `required`.
    // The provider is mocked: this checks the forwarding, not Anthropic.
    const selection = directModelSelection("anthropic/claude-sonnet-4.5", {
      toolChoice: "none",
    });
    await selection.model.doGenerate({
      prompt: [],
      tools: [
        {
          inputSchema: { type: "object" },
          name: "send_message",
          type: "function",
        },
      ],
    });

    expect(doGenerate.mock.calls[0]?.[0]).toMatchObject({
      toolChoice: { type: "none" },
    });
  });

  describe("after the turn's reply was delivered", () => {
    const usage = {
      inputTokens: {
        cacheRead: undefined,
        cacheWrite: undefined,
        noCache: 10,
        total: 10,
      },
      outputTokens: { reasoning: undefined, text: 0, total: 0 },
    };
    const stop = { raw: "stop", unified: "stop" } as const;
    const tools = {
      send_message: tool({
        inputSchema: z.object({ text: z.string() }),
      }),
    };

    function silentModel() {
      return new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [],
          finishReason: stop,
          usage,
          warnings: [],
        }),
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: "stream-start" as const, warnings: [] },
            { finishReason: stop, type: "finish" as const, usage },
          ]),
        }),
      });
    }

    async function selectionFor(
      model: MockLanguageModelV4,
      delivered: boolean
    ) {
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
      openRouter.chat.mockReturnValue(model);
      const { directModelSelection } = await import("@agent/lib/model/direct");
      return directModelSelection("openai/gpt-6-luna", {
        delivered,
        toolChoice: "auto",
      });
    }

    it("turns a step that says nothing into eve's empty delivery", async () => {
      const selection = await selectionFor(silentModel(), true);

      const generated = await generateText({
        model: selection.model,
        prompt: "done?",
        tools,
      });
      const streamed = streamText({
        model: selection.model,
        prompt: "done?",
        tools,
      });

      expect(generated.text).toBe("<eve-empty-delivery/>");
      expect(await streamed.text).toBe("<eve-empty-delivery/>");
      expect(await streamed.finishReason).toBe("stop");
    });

    it("keeps a step that wrote text or called a tool as it is", async () => {
      const model = new MockLanguageModelV4({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: "stream-start" as const, warnings: [] },
            {
              input: JSON.stringify({ text: "Ещё одно" }),
              toolCallId: "call-1",
              toolName: "send_message",
              type: "tool-call" as const,
            },
            {
              finishReason: { raw: "tool_calls", unified: "tool-calls" },
              type: "finish" as const,
              usage,
            },
          ]),
        }),
      });
      const selection = await selectionFor(model, true);

      const streamed = streamText({
        model: selection.model,
        prompt: "done?",
        tools,
      });

      expect(await streamed.text).toBe("");
      expect(await streamed.toolCalls).toHaveLength(1);
    });

    it("drops a tool call a step told to call none makes anyway", async () => {
      const toolCall = {
        input: JSON.stringify({ taskIds: ["task_1"] }),
        toolCallId: "call-1",
        toolName: "task_cancel",
        type: "tool-call" as const,
      };
      const toolCalls = { raw: "tool_calls", unified: "tool-calls" } as const;
      const model = new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [toolCall],
          finishReason: toolCalls,
          usage,
          warnings: [],
        }),
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: "stream-start" as const, warnings: [] },
            {
              id: "call-1",
              toolName: "task_cancel",
              type: "tool-input-start" as const,
            },
            {
              delta: toolCall.input,
              id: "call-1",
              type: "tool-input-delta" as const,
            },
            { id: "call-1", type: "tool-input-end" as const },
            toolCall,
            { finishReason: toolCalls, type: "finish" as const, usage },
          ]),
        }),
      });
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
      openRouter.chat.mockReturnValue(model);
      const { directModelSelection } = await import("@agent/lib/model/direct");
      const selection = directModelSelection("openai/gpt-6-luna", {
        delivered: true,
        toolChoice: "none",
      });
      const withCancel = {
        ...tools,
        task_cancel: tool({
          inputSchema: z.object({ taskIds: z.array(z.string()) }),
        }),
      };

      const generated = await generateText({
        model: selection.model,
        prompt: "done?",
        tools: withCancel,
      });
      const streamed = streamText({
        model: selection.model,
        prompt: "done?",
        tools: withCancel,
      });

      expect(generated.toolCalls).toHaveLength(0);
      expect(generated.text).toBe("<eve-empty-delivery/>");
      expect(await streamed.toolCalls).toHaveLength(0);
      expect(await streamed.text).toBe("<eve-empty-delivery/>");
      expect(await streamed.finishReason).toBe("stop");
    });

    it("leaves an empty answer to eve before anything was delivered", async () => {
      const selection = await selectionFor(silentModel(), false);

      const generated = await generateText({
        model: selection.model,
        prompt: "hello",
        tools,
      });

      expect(generated.text).toBe("");
    });

    it("turns any text of a silent step into eve's empty delivery (review #1)", async () => {
      // DeepSeek ends a stale report turn with a line the channel would post.
      const closingLine = "Отчёт уже доставлен, завершаю.";
      const talkative = new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ text: closingLine, type: "text" as const }],
          finishReason: stop,
          usage,
          warnings: [],
        }),
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: "stream-start" as const, warnings: [] },
            { id: "t", type: "text-start" as const },
            { delta: closingLine, id: "t", type: "text-delta" as const },
            { id: "t", type: "text-end" as const },
            { finishReason: stop, type: "finish" as const, usage },
          ]),
        }),
      });
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
      openRouter.chat.mockReturnValue(talkative);
      const { directModelSelection } = await import("@agent/lib/model/direct");
      const selection = directModelSelection("deepseek/deepseek-v4.1-flash", {
        delivered: true,
        silent: true,
        toolChoice: "none",
      });

      const generated = await generateText({
        model: selection.model,
        prompt: "report",
        tools,
      });
      const streamed = streamText({
        model: selection.model,
        prompt: "report",
        tools,
      });

      expect(generated.text).toBe("<eve-empty-delivery/>");
      expect(await streamed.text).toBe("<eve-empty-delivery/>");
    });
  });

  it.each([
    ["no tool call is required", "deepseek/deepseek-v4.1-flash", "auto", "off"],
    [
      "Anthropic thinks before answering",
      "anthropic/claude-sonnet-4.5",
      "required",
      "medium",
    ],
  ] as const)(
    "leaves the step as it is when %s, but for the schemas' key order",
    async (_case, modelId, toolChoice, effort) => {
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
      vi.stubEnv("OPENROUTER_REASONING_EFFORT", effort);
      const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>();
      openRouter.chat.mockImplementation(() => ({
        doGenerate,
        doStream: vi.fn<LanguageModelV4["doStream"]>(),
        modelId,
        provider: "openrouter.chat",
        specificationVersion: "v4",
        supportedUrls: {},
      }));

      const { directModelSelection } = await import("@agent/lib/model/direct");
      const selection = directModelSelection(modelId, { toolChoice });
      const prompt = [
        {
          content: [{ text: "hello", type: "text" as const }],
          role: "user" as const,
        },
      ];
      await selection.model.doGenerate({ prompt, tools: [sendMessageTool] });

      const call = doGenerate.mock.calls[0]?.[0];
      expect(call?.prompt).toEqual(prompt);
      expect(call?.toolChoice).toBeUndefined();
      expect(call?.tools).toHaveLength(1);
    }
  );

  it("lists a union's discriminator first in every tool schema", async () => {
    // Hosts that decode keys in schema order picked `replyTo` by its first
    // key: with `id` before `kind`, an automation's reply became «current».
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>();
    openRouter.chat.mockImplementation((modelId) => ({
      doGenerate,
      doStream: vi.fn<LanguageModelV4["doStream"]>(),
      modelId,
      provider: "openrouter.chat",
      specificationVersion: "v4",
      supportedUrls: {},
    }));

    const { directModelSelection } = await import("@agent/lib/model/direct");
    const selection = directModelSelection("deepseek/deepseek-v4.1-flash", {
      toolChoice: "auto",
    });
    await selection.model.doGenerate({ prompt: [], tools: [sendMessageTool] });

    const schema = doGenerate.mock.calls[0]?.[0].tools?.[0];
    const replyTo = z
      .object({
        inputSchema: z.object({
          properties: z.object({
            replyTo: z.object({
              oneOf: z.array(
                z.object({ properties: z.record(z.string(), z.unknown()) })
              ),
            }),
          }),
        }),
      })
      .parse(schema).inputSchema.properties.replyTo.oneOf;
    expect(replyTo.map((branch) => Object.keys(branch.properties))).toEqual([
      ["kind"],
      ["kind", "id"],
      ["kind", "id"],
    ]);
    expect(
      Object.keys(
        z
          .object({
            inputSchema: z.object({ properties: z.object({}).loose() }),
          })
          .parse(schema).inputSchema.properties
      )
    ).toEqual(["kind", "text", "replyTo"]);
  });

  // EN d03 and d12: `ask_question`'s «contains a non-space» `\S` let hosts
  // that match a pattern against the whole string write `{"prompt": "I"}`.
  it("sends a host no pattern it could read as the whole string", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>();
    openRouter.chat.mockImplementation((modelId) => ({
      doGenerate,
      doStream: vi.fn<LanguageModelV4["doStream"]>(),
      modelId,
      provider: "openrouter.chat",
      specificationVersion: "v4",
      supportedUrls: {},
    }));
    const inputSchema: JSONSchema7 = {
      properties: {
        alternatives: patterned("^yes|no$"),
        grouped: patterned("^(yes|no)$"),
        literalDollar: patterned("^price in \\$"),
        options: {
          items: {
            anyOf: [patterned("\\S"), patterned("^[a-z]+$")],
          },
          type: "array",
        },
        prefix: patterned("^imessage:.*"),
        prompt: patterned("[?]|\\S+\\s+\\S+\\s+\\S"),
        slug: patterned("^[A-Z0-9_]+$"),
      },
      type: "object",
    };
    const askQuestion = {
      inputSchema,
      name: "ask_question",
      type: "function" as const,
    };

    const { directModelSelection } = await import("@agent/lib/model/direct");
    await directModelSelection("deepseek/deepseek-v4.1-flash", {
      toolChoice: "required",
    }).model.doGenerate({ prompt: [], tools: [askQuestion] });

    expect(doGenerate.mock.calls[0]?.[0].tools?.[0]).toEqual({
      ...askQuestion,
      inputSchema: {
        properties: {
          alternatives: { type: "string" },
          grouped: patterned("^(yes|no)$"),
          literalDollar: { type: "string" },
          options: {
            items: { anyOf: [{ type: "string" }, patterned("^[a-z]+$")] },
            type: "array",
          },
          prefix: { type: "string" },
          prompt: { type: "string" },
          slug: patterned("^[A-Z0-9_]+$"),
        },
        type: "object",
      },
    });
    // The tool keeps its own rule, which eve checks every call against.
    expect(inputSchema.properties?.prompt).toEqual(
      patterned("[?]|\\S+\\s+\\S+\\s+\\S")
    );
  });

  // RU 25.09: hosts that decode a forced call in schema key order sent
  // `{"kind":"message","replyTo":{"kind":"current"}}` 120 times, no text:
  // DeepSeek writes `replyTo` first, and `text` was listed before it.
  it("orders send_message as DeepSeek writes it and requires its text when forced", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>();
    openRouter.chat.mockImplementation((modelId) => ({
      doGenerate,
      doStream: vi.fn<LanguageModelV4["doStream"]>(),
      modelId,
      provider: "openrouter.chat",
      specificationVersion: "v4",
      supportedUrls: {},
    }));
    const { sendMessageOutputSchema } =
      await import("@shared/chat/message-delivery");
    const sendMessage = {
      inputSchema: await asSchema(sendMessageOutputSchema).jsonSchema,
      name: "send_message",
      type: "function" as const,
    };

    const { directModelSelection } = await import("@agent/lib/model/direct");
    await directModelSelection("deepseek/deepseek-v4.1-flash", {
      toolChoice: "required",
    }).model.doGenerate({ prompt: [], tools: [sendMessage] });
    await directModelSelection("deepseek/deepseek-v4.1-flash", {
      toolChoice: "auto",
    }).model.doGenerate({ prompt: [], tools: [sendMessage] });

    const branches = doGenerate.mock.calls.map(
      ([options]) =>
        z
          .object({
            inputSchema: z.object({
              oneOf: z.array(
                z.object({
                  properties: z.record(z.string(), z.unknown()),
                  required: z.array(z.string()),
                })
              ),
              // StreamLake and GMICloud refuse a root without it.
              type: z.literal("object"),
            }),
          })
          .parse(options.tools?.[0]).inputSchema.oneOf
    );
    const [forced, free] = branches;
    expect(forced?.map((branch) => Object.keys(branch.properties))).toEqual([
      ["kind", "replyTo", "text", "attachments"],
      ["kind", "replyTo", "url"],
    ]);
    expect(forced?.[0]?.required).toEqual(["kind", "text"]);
    expect(forced?.[1]?.required).not.toContain("text");
    // A step left to the model keeps the text optional.
    expect(free?.[0]?.required).toEqual(["kind"]);
    // The tool itself still takes a photo without a caption.
    expect(
      sendMessageOutputSchema.safeParse({
        attachments: [{ kind: "image", url: "https://example.com/cat.jpg" }],
        kind: "message",
      }).success
    ).toBe(true);
  });

  it("keeps a host pinned for DeepSeek even when it is on the skip list", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("OPENROUTER_PROVIDER_ORDER", "alibaba");

    const { modelSelection } = await import("@agent/lib/model/selection");
    modelSelection("deepseek/deepseek-v4.1-flash");

    expect(openRouter.chat).toHaveBeenCalledExactlyOnceWith(
      "deepseek/deepseek-v4.1-flash",
      {
        provider: {
          ignore: [
            "morph",
            "wafer",
            "sail-research",
            "modal",
            "parasail",
            "phala",
            "inference-net",
            "open-inference",
          ],
          order: ["alibaba"],
        },
      }
    );
  });

  it("pins the configured provider order and reasoning effort", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("OPENROUTER_PROVIDER_ORDER", " Baseten , fireworks ,, ");
    vi.stubEnv("OPENROUTER_REASONING_EFFORT", "MEDIUM");

    const { modelSelection } = await import("@agent/lib/model/selection");
    const selection = modelSelection("anthropic/claude-sonnet-4.5");

    // The skipped hosts were measured on DeepSeek; another model may be
    // served by one of them alone.
    expect(openRouter.chat).toHaveBeenCalledExactlyOnceWith(
      "anthropic/claude-sonnet-4.5",
      { provider: { order: ["baseten", "fireworks"] } }
    );
    expect(selection).toMatchObject({
      modelOptions: {
        providerOptions: { openrouter: { reasoning: { effort: "medium" } } },
      },
    });
  });

  describe("on RouterAI", () => {
    /** The model a step's call reaches, answering with this cost. */
    function pricedModel(cost: number) {
      const providerMetadata = {
        openrouter: { provider: "Sail Research", usage: { cost } },
      };
      const usage = {
        inputTokens: {
          cacheRead: undefined,
          cacheWrite: undefined,
          noCache: 10,
          total: 10,
        },
        outputTokens: { reasoning: undefined, text: 2, total: 2 },
      };
      const finishReason = { raw: "stop", unified: "stop" as const };
      openRouter.chat.mockImplementation((modelId) => ({
        doGenerate: vi.fn<LanguageModelV4["doGenerate"]>(async () => ({
          content: [{ text: "Да", type: "text" }],
          finishReason,
          providerMetadata,
          usage,
          warnings: [],
        })),
        doStream: vi.fn<LanguageModelV4["doStream"]>(async () => ({
          stream: convertArrayToReadableStream([
            { id: "t", type: "text-start" },
            { delta: "Да", id: "t", type: "text-delta" },
            { id: "t", type: "text-end" },
            { finishReason, providerMetadata, type: "finish", usage },
          ]),
        })),
        modelId,
        provider: "openrouter.chat",
        specificationVersion: "v4",
        supportedUrls: {},
      }));
    }

    beforeEach(() => {
      vi.stubEnv("MODEL_PROVIDER", "routerai");
      vi.stubEnv("ROUTERAI_API_KEY", " routerai-test-key\n");
      vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    });

    // 01.10: RouterAI's own DeepSeek endpoint hung every unpinned call, and
    // DeepInfra kept the whole prompt cached on repeats.
    it("skips RouterAI's DeepSeek endpoint and pins the caching host by default", async () => {
      const { modelSelection } = await import("@agent/lib/model/selection");
      const selection = modelSelection("deepseek/deepseek-v4.1-flash");

      const { routerAiModelFetch } =
        await import("@agent/lib/model/routerai/fetch");
      expect(openRouter.createOpenRouter).toHaveBeenCalledExactlyOnceWith({
        apiKey: "routerai-test-key",
        baseURL: "https://routerai.ru/api/v1",
        // The watchdog, with RouterAI's errors made readable.
        fetch: routerAiModelFetch,
        // OpenRouter's dashboard attribution means nothing there.
        headers: {},
      });
      expect(openRouter.chat).toHaveBeenCalledExactlyOnceWith(
        "deepseek/deepseek-v4.1-flash",
        {
          provider: {
            // Sail Research caches too, but broke off answers on 01.10.
            ignore: [
              "deepseek",
              "alibaba",
              "morph",
              "wafer",
              "sail-research",
              "modal",
              "parasail",
              "phala",
              "inference-net",
              "open-inference",
            ],
            order: ["deepinfra"],
          },
        }
      );
      expect(selection).toMatchObject({
        modelContextWindowTokens: 1_048_576,
        modelOptions: {
          providerOptions: { openrouter: { reasoning: { effort: "low" } } },
        },
      });
    });

    it("leaves another model to RouterAI's routing", async () => {
      vi.stubEnv("ROUTERAI_REASONING_EFFORT", "off");

      const { modelSelection } = await import("@agent/lib/model/selection");
      const selection = modelSelection("openai/gpt-6-luna");

      expect(openRouter.chat).toHaveBeenCalledExactlyOnceWith(
        "openai/gpt-6-luna",
        { provider: undefined }
      );
      expect(selection).toMatchObject({
        modelOptions: {
          providerOptions: { openrouter: { reasoning: { enabled: false } } },
        },
      });
    });

    it("pins the configured order and skips the configured hosts for every model", async () => {
      vi.stubEnv("ROUTERAI_PROVIDER_ORDER", " DeepSeek , baidu ");
      vi.stubEnv("ROUTERAI_PROVIDER_IGNORE", "io-net, baidu");

      const { modelSelection } = await import("@agent/lib/model/selection");
      modelSelection("deepseek/deepseek-v4-flash");
      modelSelection("qwen/qwen3.7-flash");

      // A host pinned on purpose is served, even RouterAI's own DeepSeek.
      expect(openRouter.chat).toHaveBeenNthCalledWith(
        1,
        "deepseek/deepseek-v4-flash",
        {
          provider: {
            ignore: [
              "alibaba",
              "morph",
              "wafer",
              "sail-research",
              "modal",
              "parasail",
              "phala",
              "inference-net",
              "open-inference",
              "io-net",
            ],
            order: ["deepseek", "baidu"],
          },
        }
      );
      expect(openRouter.chat).toHaveBeenNthCalledWith(2, "qwen/qwen3.7-flash", {
        provider: { ignore: ["io-net"], order: ["deepseek", "baidu"] },
      });
    });

    // eve 0.62 reads a step's price only from `providerMetadata.gateway.cost`.
    it("hands eve RouterAI's roubles as dollars that convert back exactly", async () => {
      vi.stubEnv("USAGE_USD_RUB", "84.41");
      pricedModel(0.8441);

      const { directModelSelection } = await import("@agent/lib/model/direct");
      const { model } = directModelSelection("deepseek/deepseek-v4.1-flash", {
        toolChoice: "auto",
      });
      const generated = await generateText({ model, prompt: "Да?" });
      const streamed = streamText({ model, prompt: "Да?" });

      const { usdToRub } = await import("@shared/costs/prices");
      for (const metadata of [
        generated.finalStep.providerMetadata,
        (await streamed.finalStep).providerMetadata,
      ]) {
        const cost = z
          .object({ gateway: z.object({ cost: z.number() }) })
          .parse(metadata).gateway.cost;
        expect(cost).toBeCloseTo(0.01, 12);
        expect(usdToRub(cost)).toBeCloseTo(0.8441, 12);
        // What the provider package reported stays as it was.
        expect(metadata?.openrouter).toMatchObject({ usage: { cost: 0.8441 } });
      }
    });

    // 01.10: Sail Research numbers each step's calls from `call_0`, and the
    // eval's `send_message` after a `calculate` counted as the calculation.
    it("gives every call of every step an id of its own", async () => {
      const usage = {
        inputTokens: {
          cacheRead: undefined,
          cacheWrite: undefined,
          noCache: 10,
          total: 10,
        },
        outputTokens: { reasoning: undefined, text: 2, total: 2 },
      };
      const toolCalls = { raw: "tool_calls", unified: "tool-calls" } as const;
      const calls = ["Москва", "Казань"].map((city, index) => ({
        input: JSON.stringify({ city }),
        toolCallId: `call_${String(index)}`,
        toolName: "weather",
        type: "tool-call" as const,
      }));
      openRouter.chat.mockReturnValue(
        new MockLanguageModelV4({
          doGenerate: async () => ({
            content: calls,
            finishReason: toolCalls,
            usage,
            warnings: [],
          }),
          doStream: async () => ({
            stream: convertArrayToReadableStream([
              { type: "stream-start" as const, warnings: [] },
              ...calls.flatMap((call) => [
                {
                  id: call.toolCallId,
                  toolName: call.toolName,
                  type: "tool-input-start" as const,
                },
                {
                  delta: call.input,
                  id: call.toolCallId,
                  type: "tool-input-delta" as const,
                },
                { id: call.toolCallId, type: "tool-input-end" as const },
                call,
              ]),
              { finishReason: toolCalls, type: "finish" as const, usage },
            ]),
          }),
        })
      );

      const { directModelSelection } = await import("@agent/lib/model/direct");
      const { model } = directModelSelection("deepseek/deepseek-v4.1-flash", {
        toolChoice: "auto",
      });
      const weather = tool({ inputSchema: z.object({ city: z.string() }) });
      const steps = [
        await generateText({ model, prompt: "Погода?", tools: { weather } }),
        await generateText({ model, prompt: "Погода?", tools: { weather } }),
      ];
      const streamed = streamText({
        model,
        prompt: "Погода?",
        tools: { weather },
      });
      const inputStarts: string[] = [];
      for await (const part of streamed.stream) {
        if (part.type === "tool-input-start") inputStarts.push(part.id);
      }
      const streamedCalls = await streamed.toolCalls;

      const ids = [
        ...steps.flatMap((step) => step.toolCalls),
        ...streamedCalls,
      ].map((call) => call.toolCallId);
      expect(new Set(ids).size).toBe(6);
      expect(ids.some((id) => /^call_\d$/u.test(id))).toBe(false);
      // Each streamed call keeps one id from its first part to its last.
      expect(streamedCalls.map((call) => call.input)).toStrictEqual([
        { city: "Москва" },
        { city: "Казань" },
      ]);
      expect(inputStarts).toStrictEqual(
        streamedCalls.map((call) => call.toolCallId)
      );
    });

    it("leaves an OpenRouter step's metadata as it was", async () => {
      vi.stubEnv("MODEL_PROVIDER", "openrouter");
      pricedModel(0.01);

      const { directModelSelection } = await import("@agent/lib/model/direct");
      const { model } = directModelSelection("deepseek/deepseek-v4.1-flash", {
        toolChoice: "auto",
      });
      const generated = await generateText({ model, prompt: "Да?" });

      expect(generated.finalStep.providerMetadata).not.toHaveProperty(
        "gateway"
      );
    });
  });
});

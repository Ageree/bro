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
    "OPENROUTER_MODEL_CONTEXT_TOKENS",
    "OPENROUTER_PROVIDER_ORDER",
    "OPENROUTER_REASONING_EFFORT",
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
          ],
        },
      }
    );
    expect(selection).toMatchObject({
      model: { modelId: "deepseek/deepseek-v4.1-flash" },
      modelContextWindowTokens: 163_840,
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

    const { openRouterSelection } = await import("@agent/lib/model/openrouter");
    const selection = openRouterSelection("deepseek/deepseek-v4.1-flash", {
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

    const { openRouterSelection } = await import("@agent/lib/model/openrouter");
    const selection = openRouterSelection("deepseek/deepseek-v4.1-flash", {
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

    const { openRouterSelection } = await import("@agent/lib/model/openrouter");
    const selection = openRouterSelection("openai/gpt-6-luna", {
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
    const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>();
    openRouter.chat.mockImplementation((modelId) => ({
      doGenerate,
      doStream: vi.fn<LanguageModelV4["doStream"]>(),
      modelId,
      provider: "openrouter.chat",
      specificationVersion: "v4",
      supportedUrls: {},
    }));

    const { openRouterSelection } = await import("@agent/lib/model/openrouter");
    // Anthropic's extended thinking allows tool_choice auto and none and
    // rejects only a forced tool, so `none` is not downgraded like `required`.
    // The provider is mocked: this checks the forwarding, not Anthropic.
    const selection = openRouterSelection("anthropic/claude-sonnet-4.5", {
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
      const { openRouterSelection } =
        await import("@agent/lib/model/openrouter");
      return openRouterSelection("openai/gpt-6-luna", {
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
      const { openRouterSelection } =
        await import("@agent/lib/model/openrouter");
      const selection = openRouterSelection("deepseek/deepseek-v4.1-flash", {
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

      const { openRouterSelection } =
        await import("@agent/lib/model/openrouter");
      const selection = openRouterSelection(modelId, { toolChoice });
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

    const { openRouterSelection } = await import("@agent/lib/model/openrouter");
    const selection = openRouterSelection("deepseek/deepseek-v4.1-flash", {
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

    const { openRouterSelection } = await import("@agent/lib/model/openrouter");
    await openRouterSelection("deepseek/deepseek-v4.1-flash", {
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

    const { openRouterSelection } = await import("@agent/lib/model/openrouter");
    await openRouterSelection("deepseek/deepseek-v4.1-flash", {
      toolChoice: "required",
    }).model.doGenerate({ prompt: [], tools: [sendMessage] });
    await openRouterSelection("deepseek/deepseek-v4.1-flash", {
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
});

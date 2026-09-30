import type {
  OpenRouterChatSettings,
  OpenRouterProviderSettings,
} from "@openrouter/ai-sdk-provider";
import type { wrapLanguageModel } from "ai";
import type { openRouterSelection } from "@agent/lib/model/openrouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const doGenerate = vi.fn<LanguageModelV4["doGenerate"]>();

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
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  openRouter.chat.mockImplementation((modelId) => ({
    doGenerate,
    doStream: vi.fn<LanguageModelV4["doStream"]>(),
    modelId,
    provider: "openrouter.chat",
    specificationVersion: "v4",
    supportedUrls: {},
  }));
  openRouter.createOpenRouter.mockReturnValue({ chat: openRouter.chat });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const tools = [
  "ask_question",
  "send_message",
  "browser_task",
  "gmail-search",
  "list_orders",
].map((name) => ({
  inputSchema: {
    properties: {
      kind: { const: "message", type: "string" },
      text: { type: "string" },
    },
    type: "object",
  } as const,
  name,
  type: "function" as const,
}));

const person = {
  content: [{ text: "что у меня завтра?", type: "text" as const }],
  role: "user" as const,
};
const call = {
  content: [
    {
      input: "{}",
      toolCallId: "call-1",
      toolName: "gmail-search",
      type: "tool-call" as const,
    },
  ],
  role: "assistant" as const,
};
const result = {
  content: [
    {
      output: { type: "text" as const, value: "no mail" },
      toolCallId: "call-1",
      toolName: "gmail-search",
      type: "tool-result" as const,
    },
  ],
  role: "tool" as const,
};

async function step(options: Parameters<typeof openRouterSelection>[1]) {
  const { openRouterSelection } = await import("@agent/lib/model/openrouter");
  const selection = openRouterSelection(
    "deepseek/deepseek-v4.1-flash",
    options
  );
  await selection.model.doGenerate({
    prompt: [person, call, result],
    tools,
  });
  const params = doGenerate.mock.lastCall?.[0];
  if (!params) throw new Error("The model was not called.");
  return params;
}

describe("the pilot of the cache-friendly step", () => {
  it("puts the step's note after the history as a tagged user message", async () => {
    const params = await step({
      replyNote: "Сейчас у человека среда, 30 сентября 2026 г. в 12:41.",
      stableContext: true,
      toolChoice: "auto",
    });

    // The history is untouched, so the next step's prompt starts with it.
    expect(params.prompt.slice(0, 3)).toEqual([person, call, result]);
    expect(params.prompt).toHaveLength(4);
    const note = params.prompt.at(-1);
    expect(note?.role).toBe("user");
    expect(JSON.stringify(note)).toContain(
      "<bro-step-note>\\nСейчас у человека среда"
    );
    expect(JSON.stringify(note)).toContain("</bro-step-note>");
    expect(params.prompt.some(({ role }) => role === "system")).toBe(false);
  });

  it("keeps the note a last system message outside the pilot", async () => {
    const params = await step({
      replyNote: "Reply language for this turn: Russian.",
      toolChoice: "auto",
    });

    expect(params.prompt.at(-1)).toEqual({
      content: "Reply language for this turn: Russian.",
      role: "system",
    });
    expect(JSON.stringify(params.prompt)).not.toContain("bro-step-note");
    // Nor does the order of the tools change.
    expect(params.tools?.map(({ name }) => name)).toEqual(
      tools.map(({ name }) => name)
    );
  });

  it("lists send_message last, so a forced step changes only its schema", async () => {
    const forced = await step({ stableContext: true, toolChoice: "required" });
    const free = await step({ stableContext: true, toolChoice: "auto" });

    const names = [
      "ask_question",
      "browser_task",
      "gmail-search",
      "list_orders",
      "send_message",
    ];
    expect(forced.tools?.map(({ name }) => name)).toEqual(names);
    expect(free.tools?.map(({ name }) => name)).toEqual(names);
    // Every schema before it is the same in both steps.
    expect(forced.tools?.slice(0, -1)).toEqual(free.tools?.slice(0, -1));
    expect(forced.tools?.at(-1)).not.toEqual(free.tools?.at(-1));
  });

  it("offers only the tools a step is given, and none to compaction", async () => {
    const params = await step({
      offeredTools: ["browser_task", "list_orders", "send_message"],
      stableContext: true,
      toolChoice: "auto",
    });

    expect(params.tools?.map(({ name }) => name)).toEqual([
      "browser_task",
      "list_orders",
      "send_message",
    ]);

    const { openRouterSelection } = await import("@agent/lib/model/openrouter");
    const selection = openRouterSelection("deepseek/deepseek-v4.1-flash", {
      offeredTools: ["send_message"],
      replyNote: "note",
      stableContext: true,
      toolChoice: "auto",
    });
    await selection.model.doGenerate({ prompt: [person] });
    expect(doGenerate.mock.lastCall?.[0].prompt).toEqual([person]);
    expect(doGenerate.mock.lastCall?.[0].tools).toBeUndefined();
  });
});

import {
  generateText,
  isStepCount,
  type ModelMessage,
  streamText,
  tool,
} from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { annotationSchema } from "@agent/lib/staged-files/annotations";

const network = vi.hoisted(() => ({
  fetch:
    vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(),
}));

vi.mock("@agent/lib/model/stream-watchdog", () => ({
  watchedModelFetch: network.fetch,
}));

const requiredEnvironment = {
  BETTER_AUTH_SECRET: "test-auth-secret-0123456789abcdefghijklmnop",
  BETTER_AUTH_URL: "https://openinstinct.example",
  DATABASE_URL: "postgresql://user:password@example.com/database",
  OPENROUTER_API_KEY: "openrouter-test-key",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
};

const form = "/workspace/attachments/ef381f48344a471d/_2.pdf";
const miswritten = "/workspace/attachments/ef381f48344a471e/_2.pdf";
const pdf = new Uint8Array(
  Buffer.from(
    "%PDF-1.7\n1 0 obj << /Type /Pages /Count 3 >> endobj\n%%EOF\n",
    "latin1"
  )
);

/** The person's turn: the form they sent, staged as eve stages it. */
const messages: ModelMessage[] = [
  {
    content: [
      { text: "заполни анкету", type: "text" },
      { data: pdf, filename: form, mediaType: "application/pdf", type: "file" },
    ],
    role: "user",
  },
];

const usage = { completion_tokens: 2, prompt_tokens: 10, total_tokens: 12 };

type Annotation = z.infer<typeof annotationSchema>;

type ToolCallJson = ReturnType<typeof taskCall>;

/** The assistant message of a completion, as the provider's API sends it. */
interface CompletionMessage {
  readonly annotations?: readonly Annotation[];
  readonly content: string | null;
  readonly tool_calls?: readonly ToolCallJson[];
}

function completion(message: CompletionMessage) {
  return Response.json({
    choices: [
      {
        finish_reason: message.tool_calls ? "tool_calls" : "stop",
        index: 0,
        message: { role: "assistant", ...message },
      },
    ],
    created: 0,
    id: "gen-test",
    model: "deepseek/deepseek-v4.1-flash",
    object: "chat.completion",
    usage,
  });
}

/** One chunk of a streamed completion. */
function chunk(body: {
  readonly choices: readonly {
    readonly delta: {
      readonly role?: string;
      readonly tool_calls?: readonly (ToolCallJson & { index: number })[];
    };
    readonly finish_reason?: string;
    readonly index: number;
  }[];
  readonly usage?: typeof usage;
}) {
  return `data: ${JSON.stringify({ created: 0, id: "gen-test", model: "deepseek/deepseek-v4.1-flash", object: "chat.completion.chunk", ...body })}\n\n`;
}

function taskCall(path: string) {
  return {
    function: {
      arguments: JSON.stringify({ message: `Заполни ${path}` }),
      name: "task",
    },
    id: "call-task",
    type: "function",
  };
}

const sentBodySchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      annotations: z.array(z.json()).optional(),
      content: z.union([z.string(), z.array(z.json()), z.null()]),
      role: z.string(),
    })
  ),
});

/** The chat completions body of the request at `index`. */
function sentBody(index: number) {
  const body = z.string().parse(network.fetch.mock.calls[index]?.[1]?.body);
  return sentBodySchema.parse(JSON.parse(body));
}

async function selection(stagedFiles?: boolean) {
  const { directModelSelection } = await import("@agent/lib/model/direct");
  return directModelSelection("deepseek/deepseek-v4.1-flash", {
    stagedFiles,
    toolChoice: "auto",
  });
}

function taskTool() {
  const execute = vi.fn<(input: { message: string }) => Promise<string>>(
    async () => await Promise.resolve("готово")
  );
  return {
    execute,
    task: tool({ execute, inputSchema: z.object({ message: z.string() }) }),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("MODEL_PROVIDER", "openrouter");
  vi.stubEnv("OPENROUTER_PROVIDER_ORDER", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the files pilot's model calls", () => {
  it("sends the person's PDF with its sandbox path, and nothing without the pilot", async () => {
    network.fetch.mockImplementation(async () =>
      completion({ content: "Готово." })
    );

    await generateText({ messages, model: (await selection(true)).model });
    await generateText({ messages, model: (await selection()).model });

    const pilot = JSON.stringify(sentBody(0).messages[0]?.content);
    const outside = JSON.stringify(sentBody(1).messages[0]?.content);
    expect(pilot).toContain(`Attached file ${form} (application/pdf, 3`);
    expect(outside).not.toContain("Attached file");
  });

  it("runs a task call with the staged path its input miswrote", async () => {
    network.fetch.mockImplementation(async () =>
      completion({ content: null, tool_calls: [taskCall(miswritten)] })
    );
    const { execute, task } = taskTool();
    const { model } = await selection(true);

    await generateText({ messages, model, tools: { task } });

    expect(execute.mock.calls[0]?.[0]).toEqual({ message: `Заполни ${form}` });
  });

  it("mends the path of a streamed task call too", async () => {
    network.fetch.mockImplementation(
      async () =>
        new Response(
          [
            chunk({
              choices: [
                {
                  delta: {
                    role: "assistant",
                    tool_calls: [{ index: 0, ...taskCall(miswritten) }],
                  },
                  index: 0,
                },
              ],
            }),
            chunk({
              choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
              usage,
            }),
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } }
        )
    );
    const { execute, task } = taskTool();
    const { model } = await selection(true);

    const result = streamText({ messages, model, tools: { task } });
    await result.consumeStream();

    expect(execute.mock.calls[0]?.[0]).toEqual({ message: `Заполни ${form}` });
  });

  it("hands the next step the parse of the person's PDF", async () => {
    const annotation = {
      file: {
        content: [{ text: "Анкета, 3 страницы", type: "text" }],
        hash: "parse-of-the-form",
        name: form,
      },
      type: "file" as const,
    };
    network.fetch
      .mockImplementationOnce(async () =>
        completion({
          annotations: [annotation],
          content: null,
          tool_calls: [taskCall(form)],
        })
      )
      .mockImplementation(async () => completion({ content: "Готово." }));
    const { task } = taskTool();
    const { model } = await selection(true);

    await generateText({
      messages,
      model,
      stopWhen: isStepCount(2),
      tools: { task },
    });

    const answered = sentBody(1).messages.find(
      (message) => message.role === "assistant"
    );
    expect(answered?.annotations).toEqual([annotation]);
  });
});

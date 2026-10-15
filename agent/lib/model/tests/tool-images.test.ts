import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Prompt } from "@agent/lib/model/prompt";

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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const [name, value] of Object.entries(requiredEnvironment)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("MODEL_PROVIDER", "openrouter");
  network.fetch.mockImplementation(async () =>
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          message: { content: "Вижу.", role: "assistant" },
        },
      ],
      created: 0,
      id: "gen-test",
      model: "deepseek/deepseek-v4.1-flash",
      object: "chat.completion",
      usage: { completion_tokens: 2, prompt_tokens: 10, total_tokens: 12 },
    })
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function images() {
  return await import("@agent/lib/model/tool-images");
}

/** A `look` call and its result, as eve keeps them, for one remembered picture. */
async function looked(
  callId: string,
  page: number,
  picture: string,
  sessionId = "session-task"
): Promise<Prompt> {
  const { rememberLookImage } = await images();
  const ref = rememberLookImage(sessionId, picture);
  return [
    {
      content: [
        {
          input: { paths: ["/workspace/scan.pdf"] },
          toolCallId: callId,
          toolName: "look",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: {
            type: "content",
            value: [
              { text: '{"items":[]}', type: "text" },
              { text: `Снимок: scan.pdf стр. ${String(page)}`, type: "text" },
              {
                text: `[bro-look-image:${ref}|${String(page)}|${encodeURIComponent("/workspace/scan.pdf")}]`,
                type: "text",
              },
            ],
          },
          toolCallId: callId,
          toolName: "look",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

async function transformed(prompt: Prompt, sessionId = "session-task") {
  const { toolImagesMiddleware } = await images();
  const params = { prompt };
  const result = await toolImagesMiddleware({ sessionId }).transformParams?.({
    // SAFETY: the middleware reads the prompt alone.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial model stands in for the wrapped one.
    model: {} as never,
    params,
    type: "generate",
  });
  return { params, result };
}

function toolText(prompt: Prompt | undefined, index: number) {
  const message = prompt?.[index];
  const part = message?.role === "tool" ? message.content[0] : undefined;
  return part?.type === "tool-result" && part.output.type === "text"
    ? part.output.value
    : undefined;
}

describe("pictures of the task agent's tools", () => {
  it("leave a prompt without pictures as it is", async () => {
    const prompt: Prompt = [
      { content: [{ text: "Собери отчёт", type: "text" }], role: "user" },
    ];
    const { params, result } = await transformed(prompt);

    expect(result).toBe(params);
  });

  it("move the latest two looks into a user message after each, the oldest a line", async () => {
    const prompt = [
      ...(await looked("call-1", 1, "AAAA")),
      ...(await looked("call-2", 2, "BBBB")),
      ...(await looked("call-3", 3, "CCCC")),
    ];

    const sent = (await transformed(prompt)).result?.prompt;

    expect(sent?.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(toolText(sent, 1)).toContain(
      "[снимок /workspace/scan.pdf стр. 1 — уже просмотрен, вызови look снова при необходимости]"
    );
    expect(toolText(sent, 3)).toContain(
      "[изображение 1 — в следующем сообщении]"
    );
    expect(sent?.[4]).toMatchObject({
      content: [
        { type: "text" },
        { data: { data: "BBBB", type: "data" }, mediaType: "image/jpeg" },
      ],
    });
    expect(sent?.[7]).toMatchObject({
      content: [{ type: "text" }, { data: { data: "CCCC", type: "data" } }],
    });
  });

  it("never show a picture to another session", async () => {
    const prompt = await looked("call-1", 4, "AAAA", "session-other");

    const sent = (await transformed(prompt)).result?.prompt;

    expect(sent).toHaveLength(2);
    expect(toolText(sent, 1)).toContain(
      "[снимок /workspace/scan.pdf стр. 4 — недоступен, вызови look снова]"
    );
  });

  it("reach the provider as a text tool message and an image in the next user message", async () => {
    const { directModelSelection } = await import("@agent/lib/model/direct");
    const prompt = await looked("call-1", 1, "/9j/4AAQ");

    await directModelSelection("deepseek/deepseek-v4.1-flash", {
      toolChoice: "auto",
      toolImages: { sessionId: "session-task" },
    }).model.doGenerate({ prompt });

    const body = z
      .looseObject({
        messages: z.array(
          z.looseObject({ content: z.json(), role: z.string() })
        ),
      })
      .parse(
        JSON.parse(z.string().parse(network.fetch.mock.lastCall?.[1]?.body))
      );
    const tool = body.messages.find((message) => message.role === "tool");
    expect(tool?.content).toEqual(expect.any(String));
    expect(body.messages.at(-1)).toMatchObject({
      content: [
        { type: "text" },
        {
          image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" },
          type: "image_url",
        },
      ],
      role: "user",
    });
  });
});

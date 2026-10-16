import { generateText, type ModelMessage, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The AI SDK refuses a history with a tool call that got no result
 * (`AI_MissingToolResultsError`) before any model middleware sees it, so one
 * such call recorded in a session failed every later turn of it (16.10:
 * `task_cancel`, which eve never ran). eve sends each step's history through
 * `normalizeModelMessages` (`harness/messages.js`) on its way to the AI SDK,
 * and the patch drops such a call there (`patches/eve@0.62.0.patch`). eve
 * does not export the module, so the test loads it by path.
 */
interface Messages {
  readonly normalizeModelMessages: (
    messages: readonly ModelMessage[]
  ) => ModelMessage[];
}

async function loadMessages() {
  // SAFETY: `harness/messages.js` exports `normalizeModelMessages` with this signature.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- eve does not export this internal module's types.
  return (await import(
    /* @vite-ignore */ new URL(
      "../../node_modules/eve/dist/src/harness/messages.js",
      import.meta.url
    ).href
  )) as Messages;
}

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

/** A model that answers in text and keeps every prompt it was sent. */
function recordingModel(prompts: unknown[]) {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      return {
        content: [{ text: "Готово", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage,
        warnings: [],
      };
    },
  });
}

/** A call of `toolName` the model made. */
function call(callId: string, toolName: string) {
  return {
    input: {},
    toolCallId: callId,
    toolName,
    type: "tool-call" as const,
  };
}

function sent(callId: string, text: string): ModelMessage[] {
  return [
    {
      content: [
        {
          input: { kind: "message", text },
          toolCallId: callId,
          toolName: "send_message",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "json", value: { kind: "message", text } },
          toolCallId: callId,
          toolName: "send_message",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

describe("a history with a tool call that got no result", () => {
  it("still reaches the model, without that call and with everything else", async () => {
    const { normalizeModelMessages } = await loadMessages();
    // An earlier turn's call shares its id with the unanswered one: hosts
    // number a step's calls from `call_0`.
    const history: ModelMessage[] = [
      { content: "Привет", role: "user" },
      ...sent("call_0", "Привет!"),
      { content: "Заполни анкету", role: "user" },
      ...sent("call_1", "Взялся за анкету"),
      {
        content: [
          {
            input: { taskIds: ["task_1"] },
            toolCallId: "call_0",
            toolName: "task_cancel",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      { content: "Background task task_1 (task) is completed.", role: "user" },
    ];
    const prompts: unknown[] = [];

    const result = await generateText({
      messages: normalizeModelMessages(history),
      model: recordingModel(prompts),
    });

    expect(result.text).toBe("Готово");
    const prompt = JSON.stringify(prompts);
    expect(prompt).not.toContain("task_cancel");
    expect(prompt).toContain("Привет!");
    expect(prompt).toContain("Взялся за анкету");
    expect(prompt).toContain("is completed");
  });

  it("keeps a call the person answered on a card, which the AI SDK then runs", async () => {
    const { normalizeModelMessages } = await loadMessages();
    const history: ModelMessage[] = [
      { content: "Поставь ужин на 19:00", role: "user" },
      {
        content: [
          {
            input: { summary: "Ужин" },
            toolCallId: "call_0",
            toolName: "calendar-create-event",
            type: "tool-call",
          },
          {
            approvalId: "approval_0",
            toolCallId: "call_0",
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            approvalId: "approval_0",
            approved: true,
            type: "tool-approval-response",
          },
        ],
        role: "tool",
      },
    ];
    const execute = vi.fn<() => { created: boolean }>(() => ({
      created: true,
    }));

    await generateText({
      messages: normalizeModelMessages(history),
      model: recordingModel([]),
      toolApproval: async () => "user-approval" as const,
      tools: {
        "calendar-create-event": tool({
          execute,
          inputSchema: z.looseObject({}),
        }),
      },
    });

    expect(execute).toHaveBeenCalledOnce();
  });

  it("drops a result that came for the call only after the person spoke again", async () => {
    const { normalizeModelMessages } = await loadMessages();
    const history: ModelMessage[] = [
      { content: "Найди билеты", role: "user" },
      { content: [call("call_0", "web_search")], role: "assistant" },
      { content: "Не надо", role: "user" },
      {
        content: [
          {
            output: { type: "text", value: "билеты" },
            toolCallId: "call_0",
            toolName: "web_search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];
    const prompts: unknown[] = [];

    const messages = normalizeModelMessages(history);
    await generateText({ messages, model: recordingModel(prompts) });

    expect(messages).toEqual([history[0], history[2]]);
    expect(JSON.stringify(prompts)).not.toContain("web_search");
  });

  it("drops a call left waiting on a card, with its card", async () => {
    const { normalizeModelMessages } = await loadMessages();
    const history: ModelMessage[] = [
      { content: "Поставь ужин на 19:00", role: "user" },
      {
        content: [
          { text: "Ставлю ужин", type: "text" },
          call("call_0", "calendar-create-event"),
          {
            approvalId: "approval_0",
            toolCallId: "call_0",
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
      { content: "Отбой", role: "user" },
    ];
    const prompts: unknown[] = [];

    const messages = normalizeModelMessages(history);
    await generateText({ messages, model: recordingModel(prompts) });

    expect(messages).toEqual([
      history[0],
      { content: [{ text: "Ставлю ужин", type: "text" }], role: "assistant" },
      history[2],
    ]);
    expect(JSON.stringify(prompts)).not.toContain("approval_0");
  });

  it("drops an answer left with nothing but its reasoning", async () => {
    const { normalizeModelMessages } = await loadMessages();
    const history: ModelMessage[] = [
      { content: "Отмени помощника", role: "user" },
      {
        content: [
          { text: "Отменю задачу помощника", type: "reasoning" },
          call("call_0", "task_cancel"),
        ],
        role: "assistant",
      },
      { content: "Готово?", role: "user" },
    ];

    expect(normalizeModelMessages(history)).toEqual([history[0], history[2]]);
  });

  it("keeps every message it leaves alone as the very same object", async () => {
    const { normalizeModelMessages } = await loadMessages();
    const history: ModelMessage[] = [
      { content: "Привет", role: "user" },
      ...sent("call_0", "Привет!"),
      {
        content: [
          { text: "Подумаю", type: "reasoning" },
          { text: "Отменяю", type: "text" },
          call("call_1", "task_cancel"),
        ],
        role: "assistant",
      },
      { content: "Спасибо", role: "user" },
    ];

    const messages = normalizeModelMessages(history);

    expect(messages).toHaveLength(history.length);
    for (const index of [0, 1, 2, 4]) {
      expect(messages[index]).toBe(history[index]);
    }
    expect(messages[3]).toEqual({
      content: [
        { text: "Подумаю", type: "reasoning" },
        { text: "Отменяю", type: "text" },
      ],
      role: "assistant",
    });
  });
});

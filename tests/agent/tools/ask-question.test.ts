import { type FlexibleSchema, generateText, tool as aiTool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { askQuestion } from "eve/tools/ask_question";
import { describe, expect, it } from "vitest";
import tool from "@agent/tools/ask_question";

const toolBehavior = Symbol.for("eve.tool-behavior");

/**
 * The path a model's `ask_question` call takes to a question card, through
 * eve's internal modules, loaded by path and declared only as far as the
 * test uses them: `eve build` turns the tool into a definition with a JSON
 * Schema, the runtime validates each call against that schema again, and
 * eve builds cards only from the calls that passed.
 */
interface CompiledTool {
  readonly definition: {
    readonly behavior: unknown;
    readonly description: string;
    readonly inputSchema: {
      readonly properties: { readonly prompt: { readonly pattern?: string } };
    };
  };
}

interface EveQuestionPath {
  extractQuestionInputRequests(input: {
    excludedCallIds: ReadonlySet<string>;
    toolCalls: readonly { readonly toolCallId: string }[];
    tools: ReadonlyMap<string, CompiledTool["definition"]>;
  }): { kind: string; prompt: string }[];
  isInvalidToolCall(call: { readonly invalid?: boolean }): boolean;
  normalizeToolDefinition(definition: typeof tool, label: string): CompiledTool;
  toInputSchema(
    schema: CompiledTool["definition"]["inputSchema"]
  ): FlexibleSchema<unknown>;
}

async function loadInternal(path: string) {
  // SAFETY: the modules loadEve() takes apart together export every function `EveQuestionPath` declares.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- eve does not export these internal modules' types.
  return (await import(
    /* @vite-ignore */ new URL(
      `../../../node_modules/eve/dist/src/${path}`,
      import.meta.url
    ).href
  )) as EveQuestionPath;
}

async function loadEve(): Promise<EveQuestionPath> {
  const [extraction, inputErrors, definitions, schemas] = await Promise.all([
    loadInternal("harness/input-extraction.js"),
    loadInternal("harness/tool-call-input-errors.js"),
    loadInternal("internal/authored-definition/schema-backed.js"),
    loadInternal("tools/schema.js"),
  ]);
  return { ...extraction, ...inputErrors, ...definitions, ...schemas };
}

/**
 * The question cards eve puts up for one model step that calls the tool,
 * and the errors the model gets back for the calls it has to rewrite.
 */
async function stepFor(input: string) {
  const eve = await loadEve();
  const { definition } = eve.normalizeToolDefinition(
    tool,
    "agent/tools/ask_question.ts"
  );
  const result = await generateText({
    model: new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            input,
            toolCallId: "call_1",
            toolName: "ask_question",
            type: "tool-call",
          },
        ],
        finishReason: { raw: "tool_calls", unified: "tool-calls" },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
      }),
    }),
    prompt: "запомни: в поезде беру только нижнюю полку",
    tools: {
      ask_question: aiTool({
        description: definition.description,
        inputSchema: eve.toInputSchema(definition.inputSchema),
      }),
    },
  });
  // As eve's step handling does: an invalid call becomes a tool error.
  const invalid = result.toolCalls.filter((call) =>
    eve.isInvalidToolCall(call)
  );
  return {
    cards: eve.extractQuestionInputRequests({
      excludedCallIds: new Set(invalid.map((call) => call.toolCallId)),
      toolCalls: result.toolCalls,
      tools: new Map([["ask_question", definition]]),
    }),
    errors: invalid.map((call) =>
      "error" in call && call.error instanceof Error ? call.error.message : ""
    ),
  };
}

async function cardsFor(input: string) {
  return (await stepFor(input)).cards;
}

describe("ask_question", () => {
  it("stays eve's pause-for-an-answer tool", () => {
    // Without eve's behavior the definition is a tool with no execute, and
    // `eve build` rejects it; with it, eve parks the turn on the question.
    const behavior = Object.getOwnPropertyDescriptor(tool, toolBehavior);
    expect(behavior).toBeDefined();
    expect(behavior).toEqual(
      Object.getOwnPropertyDescriptor(askQuestion, toolBehavior)
    );
    expect(tool.outputSchema).toBe(askQuestion.outputSchema);
  });

  it("tells the model not to confirm what the person already asked for", () => {
    expect(tool.description).not.toBe(askQuestion.description);
    expect(tool.description).toContain(
      "Never use it to confirm what the person already asked for"
    );
    expect(tool.description).toContain(
      "Never ask which of several requested things to do: do all of them."
    );
    expect(tool.description).toContain("At most one question per request");
  });

  it("keeps its rule for the prompt in what eve build stores", async () => {
    const eve = await loadEve();
    const { definition } = eve.normalizeToolDefinition(
      tool,
      "agent/tools/ask_question.ts"
    );

    expect(definition.inputSchema.properties.prompt.pattern).toBe(
      "[?？؟]|\\S+\\s+\\S+\\s+\\S"
    );
    expect(definition.behavior).toEqual(
      Object.getOwnPropertyDescriptor(askQuestion, toolBehavior)?.value
    );
  });

  it("lists the prompt first, as the model writes it", async () => {
    // Hosts that decode keys in schema order dropped the options DeepSeek
    // wrote after a prompt listed last.
    const eve = await loadEve();
    const { definition } = eve.normalizeToolDefinition(
      tool,
      "agent/tools/ask_question.ts"
    );

    expect(Object.keys(definition.inputSchema.properties)).toEqual([
      "prompt",
      "options",
      "allowFreeform",
    ]);
    expect(definition.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["prompt"],
    });
  });

  it.each([
    [
      "an empty question (d13)",
      '{"prompt":"","options":[],"allowFreeform":true}',
    ],
    ["a question of only spaces", '{"prompt":"  \\n ","allowFreeform":true}'],
    ["one letter (EN d03, d12)", '{"prompt":"I"}'],
    ["one letter and a space", '{"prompt":"I ","allowFreeform":true}'],
    ["two words and no question mark", '{"prompt":"Hotel name"}'],
    ["a Russian fragment", '{"prompt":"Какой отель"}'],
  ])("puts up no card for %s", async (_case, input) => {
    expect(await cardsFor(input)).toEqual([]);
  });

  it("gives a one-letter question back to the model to rewrite", async () => {
    const { cards, errors } = await stepFor('{"prompt":"I"}');

    expect(cards).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Invalid input for tool ask_question");
    expect(errors[0]).toContain('"prompt"');
  });

  it.each([
    ["a short question", "Which hotel?"],
    ["an imperative", "Tell me your hotel"],
    ["a Russian question", "Какой отель?"],
    ["a question in full-width script", "你住哪个酒店？"],
  ])("puts up the card for %s", async (_case, prompt) => {
    expect(await cardsFor(JSON.stringify({ prompt }))).toMatchObject([
      { kind: "question", prompt },
    ]);
  });

  it("puts up the card for a question with words", async () => {
    expect(
      await cardsFor(
        '{"prompt":"Куда доставить: домой или на работу?","options":[{"id":"home","label":"Домой"},{"id":"work","label":"На работу"}]}'
      )
    ).toMatchObject([
      { kind: "question", prompt: "Куда доставить: домой или на работу?" },
    ]);
  });
});

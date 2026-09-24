import { askQuestion } from "eve/tools/ask_question";
import { describe, expect, it } from "vitest";
import tool from "@agent/tools/ask_question";

const toolBehavior = Symbol.for("eve.tool-behavior");

describe("ask_question", () => {
  it("stays eve's pause-for-an-answer tool", () => {
    // Without eve's behavior the definition is a tool with no execute, and
    // `eve build` rejects it; with it, eve parks the turn on the question.
    const behavior = Object.getOwnPropertyDescriptor(tool, toolBehavior);
    expect(behavior).toBeDefined();
    expect(behavior).toEqual(
      Object.getOwnPropertyDescriptor(askQuestion, toolBehavior)
    );
    expect(tool.inputSchema).toBe(askQuestion.inputSchema);
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
});

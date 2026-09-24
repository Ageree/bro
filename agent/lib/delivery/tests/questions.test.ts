import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { turnAskedQuestion } from "@agent/lib/delivery/questions";

describe("turnAskedQuestion", () => {
  it("holds from the question through the answer that resumes the turn", () => {
    const asked = [
      person("запиши меня к барберу и поставь созвон"),
      call("ask_question"),
      result("ask_question", "both"),
    ];

    expect(turnAskedQuestion(asked)).toBe(true);
    expect(
      turnAskedQuestion([
        ...asked,
        call("calendar-create-event"),
        result("calendar-create-event", "created"),
      ])
    ).toBe(true);
  });

  it("is false before any question and again after the person's next message", () => {
    expect(turnAskedQuestion([person("запомни: свинину не ем")])).toBe(false);
    expect(
      turnAskedQuestion([
        person("запомни: свинину не ем"),
        call("ask_question"),
        result("ask_question", "ignored"),
        person("а ещё нижнюю полку"),
      ])
    ).toBe(false);
  });
});

function person(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    {
      kind: "user",
    }
  );
}

function call(toolName: string): ModelMessage {
  return {
    content: [{ input: {}, toolCallId: "call-1", toolName, type: "tool-call" }],
    role: "assistant",
  };
}

function result(toolName: string, answer: string) {
  return {
    content: [
      {
        output: { type: "text" as const, value: answer },
        toolCallId: "call-1",
        toolName,
        type: "tool-result" as const,
      },
    ],
    role: "tool" as const,
  } satisfies ModelMessage;
}

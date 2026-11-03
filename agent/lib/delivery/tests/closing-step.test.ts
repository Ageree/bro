import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { answeredAndDone } from "@agent/lib/delivery/closing-step";
import {
  headsUpDeliveredNotice,
  rewriteSendNotice,
} from "@agent/lib/delivery/turn-sends";

describe("answeredAndDone", () => {
  it("is true once a delivered send_message answered the person's message", () => {
    expect(
      answeredAndDone([
        userMessage("сколько будет 2 плюс 2?"),
        toolCall("send_message", "call-1"),
        toolResult("send_message", "call-1", replyText("submitted")),
      ])
    ).toBe(true);
  });

  it("is true for an answer after tool work in earlier steps", () => {
    expect(
      answeredAndDone([
        userMessage("что у меня завтра?"),
        toolCall("calendar", "call-0"),
        toolResult("calendar", "call-0", replyText("3 events")),
        toolCall("send_message", "call-1"),
        toolResult("send_message", "call-1", replyText("submitted")),
      ])
    ).toBe(true);
  });

  it("is false while the answer is only a heads-up", () => {
    expect(
      answeredAndDone([
        userMessage("найди билеты на поезд"),
        toolCall("send_message", "call-1"),
        toolResult("send_message", "call-1", replyText(headsUpDeliveredNotice)),
      ])
    ).toBe(false);
  });

  it("is false when the step also called another tool", () => {
    expect(
      answeredAndDone([
        userMessage("запомни, что я вегетарианец и напомни завтра"),
        {
          content: [
            {
              input: { kind: "message", text: "Запомнил." },
              toolCallId: "call-1",
              toolName: "send_message",
              type: "tool-call",
            },
            {
              input: {},
              toolCallId: "call-2",
              toolName: "schedules-create",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
        toolResult("send_message", "call-1", replyText("submitted")),
        toolResult("schedules-create", "call-2", replyText("created")),
      ])
    ).toBe(false);
  });

  it("is false when the send failed the tool's check", () => {
    expect(
      answeredAndDone([
        userMessage("привет"),
        toolCall("send_message", "call-1"),
        toolResult("send_message", "call-1", {
          type: "error-text",
          value: "Invalid input for tool send_message",
        }),
      ])
    ).toBe(false);
  });

  it("is false when the send was dropped as stale", () => {
    expect(
      answeredAndDone([
        userMessage("спасибо"),
        toolCall("send_message", "call-1"),
        toolResult(
          "send_message",
          "call-1",
          replyText(rewriteSendNotice("announced"))
        ),
      ])
    ).toBe(false);
  });

  it("is false for a reaction alone", () => {
    expect(
      answeredAndDone([
        userMessage("What is 2 plus 2?"),
        toolCall("react_to_message", "call-1"),
        toolResult("react_to_message", "call-1", replyText("submitted")),
      ])
    ).toBe(false);
  });

  it("is false when the step has no tool calls", () => {
    expect(
      answeredAndDone([
        userMessage("привет"),
        { content: "Привет!", role: "assistant" },
      ])
    ).toBe(false);
    expect(answeredAndDone([userMessage("привет")])).toBe(false);
  });

  it("is false when a result is still missing from the history", () => {
    expect(
      answeredAndDone([
        userMessage("привет"),
        toolCall("send_message", "call-1"),
      ])
    ).toBe(false);
  });
});

function userMessage(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

function replyText(value: string) {
  return { type: "text" as const, value };
}

function toolCall(toolName: string, toolCallId: string): ModelMessage {
  return {
    content: [
      {
        input: { kind: "message", text: "ответ" },
        toolCallId,
        toolName,
        type: "tool-call",
      },
    ],
    role: "assistant",
  };
}

function toolResult(
  toolName: string,
  toolCallId: string,
  output: Extract<
    Extract<ModelMessage, { role: "tool" }>["content"][number],
    { type: "tool-result" }
  >["output"]
): ModelMessage {
  return {
    content: [{ output, toolCallId, toolName, type: "tool-result" }],
    role: "tool",
  };
}

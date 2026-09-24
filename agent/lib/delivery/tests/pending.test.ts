import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { awaitsDelivery, turnDelivered } from "@agent/lib/delivery/pending";
import { rewriteSendNotice } from "@agent/lib/delivery/turn-sends";

describe("awaitsDelivery", () => {
  it("waits on a person's message nothing has answered yet", () => {
    expect(awaitsDelivery([userMessage("испеки мне торт")])).toBe(true);
  });

  it("keeps waiting while the turn only ran work tools", () => {
    expect(
      awaitsDelivery([
        userMessage("найди билеты"),
        toolCall("web_search"),
        toolResult("web_search", { type: "text", value: "результаты" }),
      ])
    ).toBe(true);
  });

  it.each(["send_message", "react_to_message"])(
    "stops waiting once %s went through",
    (toolName) => {
      expect(
        awaitsDelivery([
          userMessage("спасибо"),
          toolCall(toolName),
          toolResult(toolName, { type: "text", value: "submitted" }),
        ])
      ).toBe(false);
    }
  );

  it.each(["error-text", "execution-denied"] as const)(
    "keeps waiting after a send_message that ended in %s",
    (type) => {
      const output =
        type === "error-text"
          ? { type, value: "invalid input" }
          : { type, reason: "denied" };
      expect(
        awaitsDelivery([
          userMessage("привет"),
          toolCall("send_message"),
          toolResult("send_message", output),
        ])
      ).toBe(true);
    }
  );

  it("keeps waiting after a send returned for a rewrite", () => {
    expect(
      awaitsDelivery([
        userMessage("код 123456"),
        toolCall("send_message"),
        toolResult("send_message", {
          type: "text",
          value: rewriteSendNotice("browser"),
        }),
      ])
    ).toBe(true);
  });

  it("waits again when the person writes after a delivered reply", () => {
    expect(
      awaitsDelivery([
        userMessage("привет"),
        toolCall("send_message"),
        toolResult("send_message", { type: "text", value: "submitted" }),
        userMessage("а ещё?"),
      ])
    ).toBe(true);
  });

  it("looks past framework context to the person's message", () => {
    expect(
      awaitsDelivery([
        userMessage("привет"),
        userMessage("Пометка first-contact", "context.instruction"),
      ])
    ).toBe(true);
  });

  it("lets a background task wakeup stay silent", () => {
    expect(
      awaitsDelivery([
        userMessage("найди билеты"),
        toolCall("send_message"),
        toolResult("send_message", { type: "text", value: "submitted" }),
        userMessage("task finished", "execution.background_task"),
      ])
    ).toBe(false);
  });

  it("stops forcing a reply after ten model steps without one", () => {
    const steps = (count: number) =>
      Array.from({ length: count }, () => [
        toolCall("web_search"),
        toolResult("web_search", { type: "text", value: "результаты" }),
      ]).flat();

    expect(awaitsDelivery([userMessage("найди билеты"), ...steps(9)])).toBe(
      true
    );
    expect(awaitsDelivery([userMessage("найди билеты"), ...steps(10)])).toBe(
      false
    );
  });

  it("has nothing to wait on without a person's message", () => {
    expect(awaitsDelivery([])).toBe(false);
    expect(awaitsDelivery([userMessage("summary", "context.compaction")])).toBe(
      false
    );
  });
});

describe("turnDelivered", () => {
  it("is true once this turn's reply reached the person, whoever started it", () => {
    expect(
      turnDelivered([
        userMessage("Browser run finished."),
        toolCall("send_message"),
        toolResult("send_message", { type: "text", value: "submitted" }),
      ])
    ).toBe(true);
    expect(
      turnDelivered([
        userMessage("спасибо"),
        toolCall("react_to_message"),
        toolResult("react_to_message", { type: "text", value: "submitted" }),
        userMessage("memory", "memory.recall"),
      ])
    ).toBe(true);
  });

  it("is false before the reply, after a dropped send, and for an earlier turn's reply", () => {
    expect(turnDelivered([userMessage("привет")])).toBe(false);
    expect(
      turnDelivered([
        userMessage("код 123456"),
        toolCall("send_message"),
        toolResult("send_message", {
          type: "text",
          value: rewriteSendNotice("browser"),
        }),
      ])
    ).toBe(false);
    expect(
      turnDelivered([
        userMessage("привет"),
        toolCall("send_message"),
        toolResult("send_message", { type: "text", value: "submitted" }),
        userMessage("а ещё?"),
      ])
    ).toBe(false);
  });
});

function userMessage(text: string, kind = "user"): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign({ content: text, role: "user" as const }, { kind });
}

function toolCall(toolName: string): ModelMessage {
  return {
    content: [{ input: {}, toolCallId: "call-1", toolName, type: "tool-call" }],
    role: "assistant",
  };
}

function toolResult(
  toolName: string,
  output: Extract<
    Extract<ModelMessage, { role: "tool" }>["content"][number],
    { type: "tool-result" }
  >["output"]
): ModelMessage {
  return {
    content: [{ output, toolCallId: "call-1", toolName, type: "tool-result" }],
    role: "tool",
  };
}

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  awaitsDelivery,
  outcomeToldEarlier,
  turnDelivered,
  turnSendFailed,
} from "@agent/lib/delivery/pending";
import {
  rewriteSendNotice,
  skippedSendNotice,
} from "@agent/lib/delivery/turn-sends";

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

  it("keeps waiting after only a reaction to a question", () => {
    // DeepSeek met «What is 2 plus 2?» with 😂 and wrote «4» as plain text,
    // which never reached the person.
    const reaction = [
      toolCall("react_to_message"),
      toolResult("react_to_message", { type: "text", value: "submitted" }),
    ];

    expect(
      awaitsDelivery([userMessage("What is 2 plus 2?"), ...reaction])
    ).toBe(true);
    expect(
      awaitsDelivery([
        userMessage("What is 2 plus 2?"),
        ...reaction,
        toolCall("send_message"),
        toolResult("send_message", { type: "text", value: "submitted" }),
      ])
    ).toBe(false);
  });

  it.each(["Скажи, сколько будет 2+2", "Посчитай чаевые с 3 400"])(
    "keeps waiting after only a reaction to «%s» (review #5)",
    (text) => {
      expect(
        awaitsDelivery([
          userMessage(text),
          toolCall("react_to_message"),
          toolResult("react_to_message", { type: "text", value: "submitted" }),
        ])
      ).toBe(true);
    }
  );

  it("lets a reaction answer a plain thank-you", () => {
    expect(
      awaitsDelivery([
        userMessage("спасибо, супер!"),
        toolCall("react_to_message"),
        toolResult("react_to_message", { type: "text", value: "submitted" }),
      ])
    ).toBe(false);
  });

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

/**
 * RU 25.09: a forced step sent `{"kind":"message","replyTo":{"kind":"current"}}`
 * with no text, and each of the next nine forced steps sent the same.
 */
describe("turnSendFailed", () => {
  const noText = toolResult("send_message", {
    type: "error-text",
    value:
      "Invalid input for tool send_message: A message must include text or at least one attachment.",
  });

  it("sees a send of this turn that failed the tool's check", () => {
    expect(
      turnSendFailed([
        userMessage("удали всё, что ты про меня помнишь"),
        toolCall("send_message"),
        noText,
      ])
    ).toBe(true);
  });

  it("leaves a failed work tool, a send held back and an earlier turn alone", () => {
    expect(
      turnSendFailed([
        userMessage("найди билеты"),
        toolCall("web_search"),
        toolResult("web_search", { type: "error-text", value: "timeout" }),
        toolCall("send_message"),
        toolResult("send_message", {
          type: "text",
          value: skippedSendNotice("duplicate"),
        }),
      ])
    ).toBe(false);
    expect(
      turnSendFailed([
        userMessage("привет"),
        toolCall("send_message"),
        noText,
        userMessage("а ещё?"),
      ])
    ).toBe(false);
  });
});

describe("outcomeToldEarlier", () => {
  const settled = {
    type: "json" as const,
    value: {
      outcome: "Result: корзина собрана, 1 085,95 ₽.",
      runId: "run-1",
      status: "done",
    },
  };
  const submitted = { type: "text" as const, value: "submitted" };

  it("is true once an earlier turn told the person what status handed over", () => {
    expect(
      outcomeToldEarlier(
        [
          userMessage("ну что там?"),
          toolCall("browser_task"),
          toolResult("browser_task", settled),
          toolCall("send_message"),
          toolResult("send_message", submitted),
          userMessage("Browser run run-1 finished."),
        ],
        "run-1"
      )
    ).toBe(true);
  });

  it("is false for another run, a run still at work, or an outcome nobody was told", () => {
    const told = (
      output: Parameters<typeof toolResult>[1],
      send = submitted
    ): ModelMessage[] => [
      userMessage("ну что там?"),
      toolCall("browser_task"),
      toolResult("browser_task", output),
      toolCall("send_message"),
      toolResult("send_message", send),
      userMessage("Browser run run-1 finished."),
    ];

    expect(outcomeToldEarlier(told(settled), "run-2")).toBe(false);
    expect(
      outcomeToldEarlier(
        told({ type: "json", value: { runId: "run-1", status: "running" } }),
        "run-1"
      )
    ).toBe(false);
    expect(
      outcomeToldEarlier(
        told(settled, { type: "text", value: skippedSendNotice("stale") }),
        "run-1"
      )
    ).toBe(false);
    // The report's own turn is not an earlier one.
    expect(
      outcomeToldEarlier(
        [
          userMessage("Browser run run-1 finished."),
          toolCall("browser_task"),
          toolResult("browser_task", settled),
          toolCall("send_message"),
          toolResult("send_message", submitted),
        ],
        "run-1"
      )
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

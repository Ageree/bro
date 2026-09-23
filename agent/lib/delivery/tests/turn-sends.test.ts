import type { ModelMessage, ToolResultPart } from "ai";
import { describe, expect, it } from "vitest";
import {
  sendSkipReason,
  sentMessageOf,
  skippedSendNotice,
  turnMessageLimit,
  turnMustEnd,
  turnSends,
} from "@agent/lib/delivery/turn-sends";

const callRestaurant = "Пришли название ресторана — я позвоню.";

describe("sendSkipReason", () => {
  const delivered = [sent(callRestaurant)];

  it("lets the first message of a turn through", () => {
    expect(sendSkipReason(message(callRestaurant), [])).toBeUndefined();
  });

  it.each([
    ["the same text", callRestaurant],
    ["other case and spacing", "  пришли   НАЗВАНИЕ ресторана — я позвоню "],
    ["other punctuation", "Пришли название ресторана, я позвоню!"],
    ["a near copy", "Пришли название ресторана — и я позвоню."],
  ])("drops %s as a repeat", (_case, text) => {
    expect(sendSkipReason(message(text), delivered)).toBe("duplicate");
  });

  it("delivers a different message in the same turn", () => {
    expect(
      sendSkipReason(
        message("Нашёл три варианта, вот лучший: «Пушкин», столик на 19:00."),
        delivered
      )
    ).toBeUndefined();
  });

  it("delivers the same caption with different photos", () => {
    const first = sentMessageOf(photo("https://media.example/1.jpg"));

    expect(
      sendSkipReason(photo("https://media.example/2.jpg"), [first])
    ).toBeUndefined();
    expect(sendSkipReason(photo("https://media.example/1.jpg"), [first])).toBe(
      "duplicate"
    );
  });

  it("drops a repeated native link", () => {
    const link = { kind: "link" as const, url: "https://brobro.tech/x" };
    const first = sentMessageOf(link);

    expect(sendSkipReason(link, [first])).toBe("duplicate");
  });

  it("stops every send once the turn used up its limit", () => {
    const full = Array.from({ length: turnMessageLimit }, (_, index) =>
      sent(`Сообщение номер ${String(index)} про совсем разные вещи`)
    );

    expect(sendSkipReason(message("Совершенно новое"), full)).toBe("limit");
    expect(
      sendSkipReason(message("Совершенно новое"), full.slice(1))
    ).toBeUndefined();
  });
});

describe("turnSends", () => {
  it("counts only what the current turn delivered", () => {
    const history = [
      userMessage("вчерашний вопрос"),
      ...sendMessage("old", "Готово"),
      userMessage("найди посылку"),
      ...sendMessage("a", "Ищу посылку"),
      frameworkMessage("context.instruction"),
      ...sendMessage("b", "Нашёл: она в Пулково"),
    ];

    expect(turnSends(history)).toEqual({
      delivered: [sent("Ищу посылку"), sent("Нашёл: она в Пулково")],
      skipped: 0,
    });
    expect(turnMustEnd(history)).toBe(false);
  });

  it("ignores a send that failed or was dropped", () => {
    const history = [
      userMessage("оформи возврат"),
      ...sendMessage("a", "Оформляю возврат"),
      ...sendMessage("b", "Оформляю возврат", {
        type: "text",
        value: skippedSendNotice("duplicate"),
      }),
      ...sendMessage("c", "Не вышло", {
        type: "error-text",
        value: "invalid",
      }),
    ];

    expect(turnSends(history)).toEqual({
      delivered: [sent("Оформляю возврат")],
      skipped: 1,
    });
  });

  it("ends a turn that repeated itself", () => {
    expect(
      turnMustEnd([
        userMessage("оформи возврат"),
        ...sendMessage("a", "Оформляю возврат"),
        ...sendMessage("b", "Оформляю возврат", {
          type: "text",
          value: skippedSendNotice("duplicate"),
        }),
      ])
    ).toBe(true);
  });

  it("ends a turn that reached the message limit", () => {
    const sends = Array.from({ length: turnMessageLimit }, (_, index) =>
      sendMessage(
        `call-${String(index)}`,
        `Вопрос викторины номер ${String(index)}`
      )
    ).flat();

    expect(turnMustEnd([userMessage("давай викторину"), ...sends])).toBe(true);
    expect(
      turnMustEnd([userMessage("давай викторину"), ...sends.slice(2)])
    ).toBe(false);
  });

  it("starts counting again when the person writes", () => {
    const sends = Array.from({ length: turnMessageLimit }, (_, index) =>
      sendMessage(
        `call-${String(index)}`,
        `Вопрос викторины номер ${String(index)}`
      )
    ).flat();

    expect(
      turnMustEnd([
        userMessage("давай викторину"),
        ...sends,
        userMessage("ещё"),
      ])
    ).toBe(false);
  });
});

function message(text: string) {
  return { kind: "message" as const, text };
}

function photo(url: string) {
  return {
    attachments: [{ kind: "image" as const, url }],
    kind: "message" as const,
    text: "Вот ещё",
  };
}

function sent(text: string) {
  return sentMessageOf(message(text));
}

function userMessage(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

function frameworkMessage(kind: string): ModelMessage {
  return Object.assign({ content: "context", role: "user" as const }, { kind });
}

function sendMessage(
  toolCallId: string,
  text: string,
  output: ToolResultPart["output"] = { type: "text", value: "submitted" }
): ModelMessage[] {
  return [
    {
      content: [
        {
          input: message(text),
          toolCallId,
          toolName: "send_message",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        { output, toolCallId, toolName: "send_message", type: "tool-result" },
      ],
      role: "tool",
    },
  ];
}

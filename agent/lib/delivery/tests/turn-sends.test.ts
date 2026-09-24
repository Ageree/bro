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

  it.each([
    [
      "the return flight after the outbound one",
      "Рейс SU 1234 Москва—Сочи 12 октября, вылет в 08:40 из Шереметьево, место у окна.",
      "Рейс SU 1235 Сочи—Москва 19 октября, вылет в 18:05 из Сочи, место у окна.",
    ],
    [
      "the second option after the first",
      "Вариант 1: Отель «Морской», 4 звезды, 7 400 ₽ за ночь, завтрак включён.",
      "Вариант 2: Отель «Горный», 4 звезды, 6 900 ₽ за ночь, завтрак включён.",
    ],
    [
      "a reminder that differs in name and time",
      "Готово, напомню тебе позвонить Ане завтра в 10:00.",
      "Готово, напомню тебе позвонить Пете завтра в 11:00.",
    ],
    [
      "a result that differs only in a lowercase code",
      "Готово, заказ оформлен, номер заказа order_ab, трек придёт письмом.",
      "Готово, заказ оформлен, номер заказа order_cd, трек придёт письмом.",
    ],
    [
      "the next quiz question",
      "Вопрос 3: какая река самая длинная в Европе?",
      "Вопрос 4: какая река самая длинная в Азии?",
    ],
    [
      "a confirmation question after the result",
      "Нашёл столик в «Пушкине» на 20:00 на двоих.",
      "Бронировать столик в «Пушкине» на 20:00 на двоих?",
    ],
  ])("delivers %s from the same template", (_case, first, second) => {
    expect(sendSkipReason(message(second), [sent(first)])).toBeUndefined();
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
      languageSkips: 0,
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
      languageSkips: 0,
      skipped: 1,
    });
  });

  it("ends a turn only once it keeps repeating itself", () => {
    const repeat = (id: string) =>
      sendMessage(id, "Оформляю возврат", {
        type: "text",
        value: skippedSendNotice("duplicate"),
      });
    const once = [
      userMessage("оформи возврат"),
      ...sendMessage("a", "Оформляю возврат"),
      ...repeat("b"),
    ];

    // The model may still owe a real answer after one dropped repeat.
    expect(turnMustEnd(once)).toBe(false);
    expect(turnMustEnd([...once, ...repeat("c")])).toBe(true);
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

  it("skips a send whose attachment is a relative artifact path", () => {
    // A browser result offers `/artifacts/<id>` images; a model that put one
    // into `attachments` once made this parse throw «Invalid URL» and failed
    // the turn's model selection.
    const history = [
      userMessage("найди машину"),
      ...sendMessage("call-1", "Вот машина", undefined, [
        { kind: "image", url: "/artifacts/abc" },
      ]),
    ];

    expect(turnSends(history)).toEqual({
      delivered: [],
      languageSkips: 0,
      skipped: 0,
    });
    expect(() => turnMustEnd(history)).not.toThrow();
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
  output: ToolResultPart["output"] = { type: "text", value: "submitted" },
  attachments?: readonly { kind: string; url: string }[]
): ModelMessage[] {
  return [
    {
      content: [
        {
          input:
            attachments === undefined
              ? message(text)
              : { ...message(text), attachments },
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

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { routerTurnText } from "@agent/lib/tool-router/state-string";

function person(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

function context(text: string): ModelMessage {
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "context.location" }
  );
}

function sent(text: string): ModelMessage[] {
  return [
    {
      content: [
        {
          input: { kind: "message", text },
          toolCallId: "call-1",
          toolName: "send_message",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "text", value: "submitted" },
          toolCallId: "call-1",
          toolName: "send_message",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

describe("the router's state string", () => {
  it("reads the person's words alone when Bro said nothing before", () => {
    const text = routerTurnText([person("закажи такси до работы")]);
    expect(text.state).toBe("Сообщение человека: закажи такси до работы");
    expect(text.withPrev).toBe(false);
    expect(text.prevCall).toBeUndefined();
  });

  it("puts Bro's last message first, and leaves the earlier ones out", () => {
    const text = routerTurnText([
      person("найди билеты"),
      ...sent("Нашёл три варианта."),
      ...sent("Взять второй за 4 500 ₽? Оплачиваю?"),
      person("да"),
    ]);
    expect(text.state).toBe(
      "Предыдущее сообщение Бро: Взять второй за [число] ₽? Оплачиваю?\nСообщение человека: да"
    );
    expect(text.withPrev).toBe(true);
  });

  it("cuts codes, document numbers and long numbers out", () => {
    const { state } = routerTurnText([
      person(
        "паспорт 45 10 123456, код из смс 482913, позвони на +7 916 123-45-67 в 18:00"
      ),
    ]);
    expect(state).not.toMatch(/123456|482913|916|45 10/u);
    expect(state).toContain("позвони на");
    expect(state).toContain("18:00");
  });

  it("keeps the head and the tail of a long message", () => {
    const long = `ответь на это: ${"слово ".repeat(400)}конец письма`;
    const { state } = routerTurnText([person(long)]);
    expect(state).toContain("ответь на это");
    expect(state).toContain("конец письма");
    expect(state).toContain(" … ");
    expect(state.length).toBeLessThan(1500);
  });

  it("drops eve's context and the location pilot's lines, but keeps its marker", () => {
    const text = routerTurnText([
      context("Геопозиция: человек сам прислал свою точку в 14:05: Тверская 7"),
      person("[геопозиция]\nГеопозиция: Тверская 7\nчто тут поесть?"),
    ]);
    expect(text.state).toBe(
      "Сообщение человека: [геопозиция]\nчто тут поесть?"
    );
    expect(text.located).toBe(true);
  });

  it("tells a bare photo from a photo with words", () => {
    expect(routerTurnText([person("[фото]")]).mediaOnly).toBe(true);
    expect(
      routerTurnText([person("[фото]\nсколько тут калорий в тарелке?")])
        .mediaOnly
    ).toBe(false);
  });

  it("gives the same digest to the same turn, and another to new words", () => {
    const first = routerTurnText([person("привет")]);
    const again = routerTurnText([person("привет")]);
    const other = routerTurnText([person("пока")]);
    expect(again.digest).toBe(first.digest);
    expect(other.digest).not.toBe(first.digest);
  });

  it("reads the person's answer to Bro's question in the turn", () => {
    const opener = person("свяжись с Леной");
    const before = routerTurnText([opener]);
    const asked: ModelMessage[] = [
      {
        content: [
          {
            input: {
              options: [{ id: "call", label: "Позвонить" }],
              prompt: "Написать или позвонить?",
            },
            toolCallId: "call-2",
            toolName: "ask_question",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "json",
              value: { optionId: "call", status: "answered" },
            },
            toolCallId: "call-2",
            toolName: "ask_question",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];
    const text = routerTurnText([opener, ...asked]);
    expect(text.state).toBe(
      "Сообщение человека: свяжись с Леной\nОтвет человека на вопрос Бро: Позвонить"
    );
    expect(text.answers).toEqual(["Позвонить"]);
    expect(text.digest).not.toBe(before.digest);
  });
});

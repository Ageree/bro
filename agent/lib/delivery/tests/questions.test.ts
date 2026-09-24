import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  turnAskedQuestion,
  turnAwaitsAnswer,
} from "@agent/lib/delivery/questions";

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

describe("turnAwaitsAnswer", () => {
  it("holds after a question that reached the person, until their next message", () => {
    // RU 24.09, d02: asked, and deleted the schedule three seconds later.
    const asked = [
      person("найди билеты в сочи"),
      sent("Проверка продаж уже не нужна. Остановить её сейчас или оставить?"),
      delivered("send_message"),
    ];

    expect(turnAwaitsAnswer(asked)).toBe(true);
    expect(turnAwaitsAnswer([...asked, person("останови")])).toBe(false);
  });

  it("holds nothing for a question about something else", () => {
    // A courtesy question does not put a requested deletion on hold.
    expect(
      turnAwaitsAnswer([
        person("найди билеты в сочи и убери старую проверку продаж"),
        sent("Нашёл пять вариантов. Эконом подойдёт?"),
        delivered("send_message"),
      ])
    ).toBe(false);
    // A title with a question mark in quotes asks nothing.
    expect(
      turnAwaitsAnswer([
        person("что с напоминаниями?"),
        sent("Удалил напоминание «Что дальше?» и оставил остальные."),
        delivered("send_message"),
      ])
    ).toBe(false);
  });

  it("looks only at the last message the turn got through", () => {
    expect(
      turnAwaitsAnswer([
        person("найди билеты в сочи"),
        sent("Проверка продаж уже не нужна. Остановить её?"),
        delivered("send_message"),
        sent("Проверку оставил, как ты просил вчера."),
        delivered("send_message"),
      ])
    ).toBe(false);
  });

  it("does not hold what the person asked for themselves", () => {
    expect(
      turnAwaitsAnswer([
        person("удали напоминание про созвон"),
        sent("Их два — удалить оба?"),
        delivered("send_message"),
      ])
    ).toBe(false);
  });

  it("ignores statements, links with a query string and dropped sends", () => {
    expect(
      turnAwaitsAnswer([
        person("что там с Госуслугами?"),
        sent(
          "Добавь вход в сейф: https://brobro.tech/vault?setup=vault&kind=login"
        ),
        delivered("send_message"),
        sent("[Сейф](https://brobro.tech/vault?setup=vault) — ссылка выше."),
        delivered("send_message"),
      ])
    ).toBe(false);
    expect(
      turnAwaitsAnswer([
        person("найди билеты"),
        sent("Удалить проверку?"),
        result("send_message", "Not delivered: this repeats a message."),
      ])
    ).toBe(false);
  });
});

function sent(text: string): ModelMessage {
  return {
    content: [
      {
        input: { kind: "message", text },
        toolCallId: "call-1",
        toolName: "send_message",
        type: "tool-call",
      },
    ],
    role: "assistant",
  };
}

function delivered(toolName: string) {
  return {
    content: [
      {
        output: { type: "json" as const, value: { kind: "message" } },
        toolCallId: "call-1",
        toolName,
        type: "tool-result" as const,
      },
    ],
    role: "tool" as const,
  } satisfies ModelMessage;
}

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

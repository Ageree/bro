import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  codesFromPerson,
  oneTimeCodesIn,
  onlyAsksHowItStands,
  personWordsThisTurn,
  quotedFromPerson,
} from "@agent/lib/browser-use/said";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

function person(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    {
      kind: "user",
    }
  );
}

function asked(options: readonly { id: string; label: string }[] = []) {
  return {
    content: [
      {
        input: { options, prompt: "Какой код пришёл?" },
        toolCallId: "ask-1",
        toolName: "ask_question",
        type: "tool-call" as const,
      },
    ],
    role: "assistant" as const,
  } satisfies ModelMessage;
}

function answered(answer: { optionId?: string; text?: string }) {
  return {
    content: [
      {
        output: {
          type: "json" as const,
          value: { status: "answered", ...answer },
        },
        toolCallId: "ask-1",
        toolName: "ask_question",
        type: "tool-result" as const,
      },
    ],
    role: "tool" as const,
  } satisfies ModelMessage;
}

describe("the one-time codes a follow-up carries", () => {
  it("finds the code a report turn made up on 25.09", () => {
    expect(
      oneTimeCodesIn(
        "Пользователь прислал действующий SMS-код из сообщения: 739204",
        { awaitingCode: false }
      )
    ).toEqual(["739204"]);
  });

  it("finds a code a word for it leads, however it is spaced", () => {
    expect(
      oneTimeCodesIn("Код из смс 992130", { awaitingCode: false })
    ).toEqual(["992130"]);
    expect(
      oneTimeCodesIn("код подтверждения: 4821", { awaitingCode: false })
    ).toEqual(["4821"]);
    expect(oneTimeCodesIn("Вот код 739 204", { awaitingCode: false })).toEqual([
      "739204",
    ]);
  });

  it("leaves numbers that are not one-time codes alone", () => {
    for (const text of [
      "Промокод 1234 на первый заказ",
      "Код домофона 4567, подъезд 2",
      "Код подразделения 770-001",
      "Бюджет до 8 000 ₽, заезд 25.09.2026",
    ]) {
      expect(oneTimeCodesIn(text, { awaitingCode: false })).toEqual([]);
    }
  });

  it("takes any bare number for a code once the run waits for one", () => {
    expect(
      oneTimeCodesIn("Вводи 482913 и продолжай", { awaitingCode: true })
    ).toEqual(["482913"]);
  });

  it("accepts a code only when the person wrote those very digits", () => {
    expect(codesFromPerson(["482913"], ["код 482 913"])).toBe(true);
    expect(codesFromPerson(["482914"], ["код 482913"])).toBe(false);
    expect(codesFromPerson(["482913"], [])).toBe(false);
  });
});

describe("the person's words this turn", () => {
  it("is the message they opened the turn with", () => {
    expect(
      personWordsThisTurn([person("найди такси"), person("код 482913")])
    ).toEqual(["код 482913"]);
  });

  it("is nothing in a turn Bro opened", () => {
    expect(
      personWordsThisTurn([
        person("код 482913"),
        person(`${backgroundTurnMarker}\nBrowser run r-1 finished.`),
      ])
    ).toEqual([]);
    expect(
      personWordsThisTurn([
        Object.assign(
          { content: "Browser run r-1 finished.", role: "user" as const },
          {
            kind: "execution.background_task",
          }
        ) satisfies ModelMessage,
      ])
    ).toEqual([]);
  });

  it("includes what they answered to a question in the turn", () => {
    expect(
      personWordsThisTurn([
        person("ну что там?"),
        asked(),
        answered({ text: "739204" }),
      ])
    ).toEqual(["ну что там?", "739204"]);
    expect(
      personWordsThisTurn([
        person("бери"),
        asked([{ id: "window", label: "У окна" }]),
        answered({ optionId: "window" }),
      ])
    ).toEqual(["бери", "У окна"]);
  });
});

describe("a quote of the person", () => {
  it("matches their words whatever the case, «ё» or punctuation", () => {
    expect(
      quotedFromPerson("можно до 8 тысяч", [
        "Ну давай, можно до 8 тысяч — но не дороже",
      ])
    ).toBe(true);
    expect(quotedFromPerson("Берём ещё", ["берем еще!"])).toBe(true);
  });

  it("rejects words they did not write", () => {
    // RU 25.09, d01: the person wrote only «ну что там?».
    expect(
      quotedFromPerson("разрешает более высокий бюджет", ["ну что там?"])
    ).toBe(false);
    // A whole word, not part of one.
    expect(quotedFromPerson("да", ["давай подумаем"])).toBe(false);
  });

  it("knows a question about how things stand from an instruction", () => {
    for (const words of [
      "ну что там?",
      "Что там?",
      "как дела с билетами?",
      "есть новости?",
      "что там по такси",
      "ну как, получилось?",
    ]) {
      expect(onlyAsksHowItStands(words)).toBe(true);
    }
    for (const words of ["бери первый", "да", "можно до 8 тысяч", "482913"]) {
      expect(onlyAsksHowItStands(words)).toBe(false);
    }
  });
});

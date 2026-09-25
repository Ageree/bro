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

function replied() {
  return {
    content: [{ text: "Готово.", type: "text" as const }],
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

  it("finds a code with punctuation around it", () => {
    for (const text of [
      "Пользователь прислал код: 739204.",
      "Пользователь прислал действующий SMS-код: 739204.",
      "SMS-код:739204",
      "Код из SMS: 739204, введи его",
    ]) {
      expect(oneTimeCodesIn(text, { awaitingCode: false })).toEqual(["739204"]);
    }
    for (const text of ["1234.56", "10:30:45", "25.09.2026", "1,234,567"]) {
      expect(oneTimeCodesIn(text, { awaitingCode: true })).toEqual([]);
    }
  });

  it("tells an amount, a year or an id from a code the run waits for", () => {
    expect(
      oneTimeCodesIn(
        "Человек подтвердил оплату 4 890 ₽ в приложении банка, проверь",
        { awaitingCode: true }
      )
    ).toEqual([]);
    expect(
      oneTimeCodesIn("Код 739204, заверши запись на 15 октября 2026", {
        awaitingCode: true,
      })
    ).toEqual(["739204"]);
    expect(
      oneTimeCodesIn("Код 739204, рейс SU 1234", { awaitingCode: true })
    ).toEqual(["739204"]);
  });

  it("accepts a code only when the person wrote those very digits", () => {
    expect(codesFromPerson(["482913"], ["код 482 913"])).toBe(true);
    // Pasted from the SMS or typed with a full stop.
    expect(
      codesFromPerson(
        ["739204"],
        ["Код для входа на Госуслуги: 739204. Никому не сообщайте его"]
      )
    ).toBe(true);
    expect(codesFromPerson(["739204"], ["739204, вводи"])).toBe(true);
    expect(codesFromPerson(["739204"], ["код:739204"])).toBe(true);
    expect(codesFromPerson(["482914"], ["код 482913"])).toBe(false);
    expect(codesFromPerson(["482913"], [])).toBe(false);
  });
});

describe("the person's words this turn", () => {
  const report = person(`${backgroundTurnMarker}\nBrowser run r-1 finished.`);

  it("is the message they opened the turn with, not an earlier turn's", () => {
    expect(
      personWordsThisTurn([
        person("найди такси"),
        replied(),
        person("код 482913"),
      ])
    ).toEqual(["код 482913"]);
  });

  it("keeps a message they sent while the turn ran", () => {
    // eve steers a message sent mid-turn in as one more user message: after
    // a tool result, or right after the message whose step it cut off.
    expect(
      personWordsThisTurn([
        person("739204"),
        asked(),
        answered({ text: "да, это он" }),
        person("это код из смс, вводи быстрее"),
      ])
    ).toEqual(["739204", "это код из смс, вводи быстрее", "да, это он"]);
    expect(
      personWordsThisTurn([replied(), person("739204"), person("вводи")])
    ).toEqual(["739204", "вводи"]);
  });

  it("is nothing in a turn Bro opened that the person said nothing in", () => {
    expect(personWordsThisTurn([person("код 482913"), report])).toBeNull();
    expect(
      personWordsThisTurn([person("код 482913"), replied(), report, asked()])
    ).toBeNull();
    expect(
      personWordsThisTurn([
        Object.assign(
          { content: "Browser run r-1 finished.", role: "user" as const },
          {
            kind: "execution.background_task",
          }
        ) satisfies ModelMessage,
      ])
    ).toBeNull();
  });

  it("counts what the person wrote into a turn Bro opened", () => {
    expect(
      personWordsThisTurn([
        person("найди такси"),
        replied(),
        report,
        person("739204"),
      ])
    ).toEqual(["739204"]);
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
    // «Готово» is the reply to «confirm it in the app and tell me».
    for (const words of [
      "бери первый",
      "да",
      "можно до 8 тысяч",
      "482913",
      "Готово",
      "готово!",
      "Готово.",
    ]) {
      expect(onlyAsksHowItStands(words)).toBe(false);
    }
    expect(onlyAsksHowItStands("Готово?")).toBe(true);
  });
});

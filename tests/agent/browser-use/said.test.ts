import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  codesNotFromPerson,
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

  it("lets a word for a code win over a capitalised prefix", () => {
    for (const text of [
      "Пользователь прислал SMS 739204 введи его",
      "Введи СМС 739204",
      "Вот OTP 739204",
      // Only an amount after it takes the code back, not any word.
      "SMS 739204 годен 5 минут",
      "СМС 739204 минуту назад пришла",
    ]) {
      expect(oneTimeCodesIn(text, { awaitingCode: false })).toEqual(["739204"]);
    }
    for (const text of [
      "SU 1234",
      "S7 1234",
      "№ 48213",
      "рейс su 1234",
      "заказ 48213",
      "2026-10-15",
    ]) {
      expect(oneTimeCodesIn(text, { awaitingCode: true })).toEqual([]);
    }
  });

  it("lets a word for a code naming the number win over an order or a flight", () => {
    // An order's SMS reads «Код для подтверждения заказа».
    for (const text of [
      "Пользователь прислал код подтверждения заказа 739204, введи его",
      "Введи код для заказа 739204",
      "Код из смс для заказа 739204",
      "Код по заказу 739204",
      "Введи код подтверждения заказа 739204",
      "Код от ВТБ 739204",
      "Введи код, пришедший для заказа 739204",
    ]) {
      expect(oneTimeCodesIn(text, { awaitingCode: true })).toEqual(["739204"]);
    }
    // A clause of its own keeps the order and the flight what they are.
    expect(
      oneTimeCodesIn("Код 739204, заказ 48213, рейс SU 1234", {
        awaitingCode: true,
      })
    ).toEqual(["739204"]);
  });

  it("reads an order or a flight number before the code as its label", () => {
    // The person sent 739204: their own code is the only one here.
    for (const text of [
      "Код подтверждения заказа 48213: 739204",
      "Код для заказа №48213: 739204",
      "Код от Ozon для заказа 48213: 739204",
      "Код подтверждения брони на рейс SU 1234: 739204",
    ]) {
      expect(oneTimeCodesIn(text, { awaitingCode: true })).toEqual(["739204"]);
    }
  });

  it("finds no code where a code is only mentioned", () => {
    for (const text of [
      "Код не пришёл — оформи заказ 48213 без SMS-подтверждения",
      "Не жди SMS-код и оформи заказ 48213",
    ]) {
      expect(oneTimeCodesIn(text, { awaitingCode: true })).toEqual([]);
    }
    for (const text of [
      "Проверь статус. Код для заказа 48213 не нужен",
      "Доставка на Ленина 5, кв. 12, код для входа 4567",
      "Код домофона 4567",
    ]) {
      expect(oneTimeCodesIn(text, { awaitingCode: false })).toEqual([]);
    }
  });

  it("keeps an amount an amount after a word like «SMS»", () => {
    expect(
      oneTimeCodesIn("Человек подтвердил оплату по смс из банка 4 890 ₽", {
        awaitingCode: true,
      })
    ).toEqual([]);
    expect(
      oneTimeCodesIn("Списали по SMS 1500 руб", { awaitingCode: true })
    ).toEqual([]);
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

  // RU 25.09, d04: a follow-up naming the pickup point by the person's
  // address was refused as carrying the code «119192».
  it("reads a postal index in an address as no code", () => {
    const waiting = { awaitingCode: true };
    expect(
      oneTimeCodesIn(
        "пункт выдачи (прошлый, иначе ближайший к адресу Мичуринский проспект, ***, Москва, 119192), дойти до страницы оплаты",
        waiting
      )
    ).toEqual([]);
    expect(
      oneTimeCodesIn("Доставка: 119192, Москва, ул. Лобачевского, 5", waiting)
    ).toEqual([]);
    expect(oneTimeCodesIn("почтовый индекс 119192", waiting)).toEqual([]);
    expect(
      oneTimeCodesIn("адрес: г. Казань, Баумана, 7, 420111", waiting)
    ).toEqual([]);
  });

  it("still finds a code that only looks like a postal index", () => {
    const waiting = { awaitingCode: true };
    expect(oneTimeCodesIn("119192", waiting)).toEqual(["119192"]);
    expect(oneTimeCodesIn("Код: 119192", { awaitingCode: false })).toEqual([
      "119192",
    ]);
    expect(oneTimeCodesIn("SMS 119192", { awaitingCode: false })).toEqual([
      "119192",
    ]);
    expect(
      oneTimeCodesIn("Введи код, 119192, и заверши вход", waiting)
    ).toEqual(["119192"]);
    // A comma alone is no address: nothing around it names a street or city.
    expect(
      oneTimeCodesIn("Человек прислал, 119192, продолжай", waiting)
    ).toEqual(["119192"]);
    // Code words win over an address after them.
    expect(
      oneTimeCodesIn("Код из смс 119192, Москва, ул. Лобачевского", waiting)
    ).toEqual(["119192"]);
  });

  it("accepts a code only when the person wrote those very digits", () => {
    expect(codesNotFromPerson(["482913"], ["код 482 913"])).toEqual([]);
    // Pasted from the SMS or typed with a full stop.
    expect(
      codesNotFromPerson(
        ["739204"],
        ["Код для входа на Госуслуги: 739204. Никому не сообщайте его"]
      )
    ).toEqual([]);
    expect(codesNotFromPerson(["739204"], ["739204, вводи"])).toEqual([]);
    expect(codesNotFromPerson(["739204"], ["код:739204"])).toEqual([]);
    expect(codesNotFromPerson(["482914"], ["код 482913"])).toEqual(["482914"]);
    expect(codesNotFromPerson(["482913"], [])).toEqual(["482913"]);
    // Only what the person did not write is named, never their own code.
    expect(
      codesNotFromPerson(["48213", "739204", "739204"], ["739204"])
    ).toEqual(["48213"]);
  });
});

describe("the person's words this turn", () => {
  const report = person(`${backgroundTurnMarker}\nBrowser run r-1 finished.`);
  const nothing = { answers: [], said: null };

  it("is the message they opened the turn with, not an earlier turn's", () => {
    expect(
      personWordsThisTurn([
        person("найди такси"),
        replied(),
        person("код 482913"),
      ])
    ).toEqual({ answers: [], said: ["код 482913"] });
  });

  it("keeps the messages they sent one after another", () => {
    // «739204», then a second later «это код»: eve steers the second into
    // the same turn, with nothing of Bro's between them.
    expect(
      personWordsThisTurn([replied(), person("739204"), person("это код")])
    ).toEqual({ answers: [], said: ["739204", "это код"] });
  });

  it("stops at anything of Bro's, an earlier turn's words never count", () => {
    // eve's history has no turn id, but a turn Bro answered always leaves a
    // reply or a tool result before the person's next message.
    expect(
      personWordsThisTurn([
        person("739204"),
        asked(),
        answered({ text: "да, это он" }),
        person("это код из смс, вводи быстрее"),
      ])
    ).toEqual({ answers: [], said: ["это код из смс, вводи быстрее"] });
    expect(
      personWordsThisTurn([person("739204"), report, person("вводи")])
    ).toEqual({ answers: [], said: ["вводи"] });
  });

  it("is nothing in a turn Bro opened that the person said nothing in", () => {
    expect(personWordsThisTurn([person("код 482913"), report])).toEqual(
      nothing
    );
    expect(
      personWordsThisTurn([person("код 482913"), replied(), report, asked()])
    ).toEqual(nothing);
    expect(
      personWordsThisTurn([
        Object.assign(
          { content: "Browser run r-1 finished.", role: "user" as const },
          {
            kind: "execution.background_task",
          }
        ) satisfies ModelMessage,
      ])
    ).toEqual(nothing);
  });

  it("keeps their answers to a question in a turn Bro opened apart", () => {
    // The answer is theirs, the turn is not: it earns no consent.
    expect(
      personWordsThisTurn([
        person("найди такси"),
        replied(),
        report,
        asked(),
        answered({ text: "739204" }),
      ])
    ).toEqual({ answers: ["739204"], said: null });
  });

  it("counts what the person wrote into a turn Bro opened", () => {
    expect(
      personWordsThisTurn([
        person("найди такси"),
        replied(),
        report,
        person("739204"),
      ])
    ).toEqual({ answers: [], said: ["739204"] });
  });

  it("includes what they answered to a question in the turn", () => {
    expect(
      personWordsThisTurn([
        person("ну что там?"),
        asked(),
        answered({ text: "739204" }),
      ])
    ).toEqual({ answers: ["739204"], said: ["ну что там?"] });
    expect(
      personWordsThisTurn([
        person("бери"),
        asked([{ id: "window", label: "У окна" }]),
        answered({ optionId: "window" }),
      ])
    ).toEqual({ answers: ["У окна"], said: ["бери"] });
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
    // A reply with no words — the go-ahead after a push or 3-D Secure.
    expect(quotedFromPerson("👍", ["👍"])).toBe(true);
    expect(quotedFromPerson("+", [" + "])).toBe(true);
    expect(quotedFromPerson("👍", ["ну что там?"])).toBe(false);
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

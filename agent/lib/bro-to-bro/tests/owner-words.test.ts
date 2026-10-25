import { describe, expect, it } from "vitest";
import {
  homeLike,
  meetingLength,
  namedAmounts,
  namedItems,
  namedPlace,
  namedTime,
  namedSums,
  ownerText,
  paymentCovered,
  paymentsSaid,
  paysTogether,
  peerPaymentCovered,
  peerPaysSaid,
  promisesIn,
} from "@agent/lib/bro-to-bro/owner-words";

const moscow = "Europe/Moscow";
/** Sunday 25.10.2026, noon in Moscow. */
const now = Date.parse("2026-10-25T12:00:00+03:00");

function at(local: string) {
  return `2026-${local}:00+03:00`;
}

function exact(text: string, start: string) {
  return namedTime(
    ownerText([text]),
    { at: at(start), window: { from: at(start), to: at(start) } },
    moscow,
    now
  );
}

function window(text: string, from: string, to: string) {
  return namedTime(
    ownerText([text]),
    { at: null, window: { from: at(from), to: at(to) } },
    moscow,
    now
  );
}

describe("namedTime", () => {
  it.each([
    ["договорись с Борисом об ужине в субботу в 19:00", "10-31T19:00"],
    ["в субботу в 7 вечера в Пушкине", "10-31T19:00"],
    ["завтра в 19", "10-26T19:00"],
    ["31.10 в 19.30", "10-31T19:30"],
    ["в субботу в семь вечера", "10-31T19:00"],
  ])("finds an exact start the owner said: %s", (text, start) => {
    expect(exact(text, start)).toBe(true);
  });

  it.each([
    ["ужин в субботу в 19", "10-31T20:00", "another hour"],
    ["ужин в субботу в 19", "11-01T19:00", "another day"],
    ["договорись об ужине на выходных", "10-31T19:00", "no hour at all"],
  ])("does not take %s as %s (%s)", (text, start) => {
    expect(exact(text, start)).toBe(false);
  });

  it("pairs a day with its own hour, and takes nothing the owner said no to", () => {
    const choice = "в субботу в 18 или в воскресенье в 19";
    expect(exact(choice, "10-31T19:00")).toBe(false);
    expect(exact(choice, "11-01T19:00")).toBe(true);
    expect(exact("в субботу в 19 не могу", "10-31T19:00")).toBe(false);
    expect(exact("в субботу в 18, в воскресенье в 19", "10-31T19:00")).toBe(
      false
    );
    expect(
      exact(
        "Петя написал: «в субботу в 19 в Пушкине». Я пока думаю",
        "10-31T19:00"
      )
    ).toBe(false);
    expect(exact("кроме субботы, в субботу в 19 занят", "10-31T19:00")).toBe(
      false
    );
    expect(window("в субботу в 19", "10-31T10:00", "10-31T23:00")).toBe(false);
    expect(exact("я завтра до 18 на работе", "10-26T18:00")).toBe(false);
    expect(exact("в субботу приду с 2 детьми", "10-31T14:00")).toBe(false);
    expect(
      window(
        "в субботу вечером я занят, давай на неделе",
        "10-31T17:00",
        "11-01T00:00"
      )
    ).toBe(false);
  });

  it("takes no time from a quote, however short, nor one the owner has something on", () => {
    expect(exact("Его вариант: «суббота 19:00»", "10-31T19:00")).toBe(false);
    expect(exact("Боря: «в субботу в 19»", "10-31T19:00")).toBe(false);
    expect(exact("«в субботу в 19", "10-31T19:00")).toBe(false);
    expect(exact("давай вместо субботы в 19", "10-31T19:00")).toBe(false);
    expect(exact("Петя написал:\n> суббота 19:00", "10-31T19:00")).toBe(false);
    expect(exact("Петя написал:\nв субботу в 19", "10-31T19:00")).toBe(false);
    expect(exact("Петя написал. Давай в субботу в 19", "10-31T19:00")).toBe(
      true
    );
    expect(
      window("в субботу вечером у меня футбол", "10-31T17:00", "11-01T00:00")
    ).toBe(false);
  });

  it("reads the owner's words of a voice message, not the voice's own line", () => {
    const voice = "[голосом] (ты: «В субботу в 19:00 удобно?»)\nда, давай";
    expect(
      namedTime(
        ownerText([voice]),
        {
          at: at("10-31T19:00"),
          window: { from: at("10-31T19:00"), to: at("10-31T20:00") },
        },
        moscow,
        now
      )
    ).toBe(false);
    expect(
      exact(
        "[голосом] договорись с Борисом на субботу в семь вечера",
        "10-31T19:00"
      )
    ).toBe(true);
  });

  it.each([
    ["в субботу вечером", "10-31T18:00", "10-31T23:00"],
    ["на выходных", "10-31T00:00", "11-02T00:00"],
    ["в субботу после 19", "10-31T19:00", "11-01T00:00"],
  ])("takes a window no wider than said: %s", (text, from, to) => {
    expect(window(text, from, to)).toBe(true);
  });

  it.each([
    ["в субботу вечером", "10-31T12:00", "10-31T23:00"],
    ["в субботу", "10-31T00:00", "11-02T00:00"],
    ["на этой неделе", "10-26T00:00", "10-31T00:00"],
    ["в субботу после 19", "10-31T17:00", "10-31T23:00"],
  ])("does not take a window wider than %s", (text, from, to) => {
    expect(window(text, from, to)).toBe(false);
  });
});

describe("namedPlace", () => {
  it("finds a venue the owner named in any form", () => {
    expect(
      namedPlace(ownerText(["поужинаем в Пушкине"]), "ресторан «Пушкин»")
    ).toBe(true);
    expect(
      namedPlace(
        ownerText(["кофе в даблби на чистых прудах"]),
        "Даблби, Чистые пруды"
      )
    ).toBe(true);
  });

  it("does not take a place the owner did not name, nor a home", () => {
    expect(namedPlace(ownerText(["поужинаем в субботу"]), "Пушкин")).toBe(
      false
    );
    expect(
      namedPlace(ownerText(["у меня на Тверской 26"]), "Тверская 26")
    ).toBe(false);
    expect(homeLike("у меня дома")).toBe(true);
    expect(homeLike("кв. 5")).toBe(true);
    expect(homeLike("ресторан «Пушкин» на Тверском бульваре")).toBe(false);
    expect(homeLike("ужин у Бориса")).toBe(true);
    expect(homeLike("в гостях у Ани")).toBe(true);
    expect(homeLike("кафе у метро Пушкинская")).toBe(false);
  });
});

describe("namedAmounts", () => {
  it.each([
    ["скинемся по 3000", 3000],
    ["по 3 000 ₽", 3000],
    ["три тысячи", 3000],
    ["бюджет 5к", 5000],
    ["2,5 тыс.", 2500],
  ])("reads %s as %d", (text, sum) => {
    expect(namedAmounts(text)).toContain(sum);
  });

  it("takes as the owner's sum only a number about money, in roubles", () => {
    expect(namedSums(ownerText(["скинемся по 3000"]))).toEqual([3000]);
    expect(namedSums(ownerText(["возьми 3000 листов бумаги"]))).toEqual([]);
    expect(
      namedSums(ownerText(["на подарок возьми 3000 листов бумаги"]))
    ).toEqual([]);
    expect(namedSums(ownerText(["возьми три тысячи листов бумаги"]))).toEqual(
      []
    );
    expect(namedSums(ownerText(["по 3000 долларов"]))).toEqual([]);
    expect(namedSums(ownerText(["бюджет 5к"]))).toEqual([5000]);
    expect(namedSums(ownerText(["бюджет 5000, ему не говори"]))).toEqual([]);
    expect(namedSums(ownerText(["На печать листов 3000, цену узнай"]))).toEqual(
      []
    );
    expect(namedSums(ownerText(["по 3 тысячи с каждого"]))).toEqual([3000]);
    expect(namedSums(ownerText(["давай до 21, скинемся по 3000"]))).toEqual([
      3000,
    ]);
    expect(namedSums(ownerText(["Его ответ: «скинусь 3000 ₽»"]))).toEqual([]);
    expect(namedSums(ownerText(["Оплатим ужин за 30 человек"]))).toEqual([]);
  });

  it("takes no clock time or date for a sum", () => {
    expect(namedAmounts("в субботу 31.10 в 19:30")).toEqual([]);
  });
});

describe("namedItems", () => {
  const people = ["Савелий", "Борис"];

  it("takes points whose words, but the two people's names, the owner said", () => {
    const said = ownerText([
      "договорись с братом, кто что берёт на дачу: я беру мясо и угли",
    ]);
    expect(namedItems(said, ["Савелий — мясо и угли"], people)).toBe(true);
    expect(
      namedItems(said, ["Савелий — мясо", "Маша (дочь) едет с нами"], people)
    ).toBe(false);
  });
});

describe("namedItems, of a third person", () => {
  it("finds a third person's name in the owner's words, never takes it for granted", () => {
    const said = ownerText(["я беру мясо и торт"]);
    expect(namedItems(said, ["Маша — торт"], ["Савелий", "Борис"])).toBe(false);
    // Only the two people's own names go without saying, in any case.
    expect(namedItems(said, ["Марии — торт"], ["Савелий", "Мария"])).toBe(true);
    expect(namedItems(said, ["Марина — торт"], ["Савелий", "Мария"])).toBe(
      false
    );
    expect(
      namedItems(
        ownerText(["договорись с Марией: я беру мясо и торт"]),
        ["Марина — торт"],
        ["Савелий", "Мария"]
      )
    ).toBe(false);
  });
});

describe("paymentsSaid", () => {
  it.each([
    ["скинемся маме на подарок", ["скинемся маме на подарок"]],
    ["я куплю торт", ["я куплю торт"]],
    ["торт я куплю", ["торт я куплю"]],
    ["я плачу", ["я плачу"]],
    ["готов дать 3000 на цветы", ["готов дать 3000 на цветы"]],
    ["я куплю торт, Борис купит машину", ["я куплю торт"]],
  ])("hears what the owner pays for: %s", (text, paysFor) => {
    expect(paymentsSaid(ownerText([text]))).toEqual(paysFor);
  });

  it.each([
    "договорись, кто покупает",
    "он заплатит",
    "я не оплачу ужин",
    "Петя написал: «я оплачу ужин»",
    "попроси Петю купить ужин",
    "пусть он купит",
    "узнай, сколько надо заплатить",
    "я за неё не заплачу",
    "что купить маме",
    "спроси, не хочет ли он скинуться",
    "может, скинемся?",
    "Борис думает, что я заплачу за всех",
    "Его ответ: «оплачу торт»",
    "Петя написал:\n> оплачу торт",
  ])("hears no promise of the owner's in: %s", (text) => {
    expect(paymentsSaid(ownerText([text]))).toEqual([]);
  });

  it("covers a promise only when all of it is what the owner said they pay for", () => {
    const names = { other: "Пётр", payer: "Савелий" };
    expect(paymentCovered("Савелий купит торт", ["торт"], names)).toBe(true);
    // The other one is no payer of the owner's promise, nor whom it is for.
    expect(paymentCovered("Пётр купит торт", ["я куплю торт"], names)).toBe(
      false
    );
    expect(paymentCovered("Петру куплю торт", ["я куплю торт"], names)).toBe(
      false
    );
    expect(
      paymentCovered("Савелий с Петром купят торт", ["я куплю торт"], names)
    ).toBe(true);
    expect(
      paymentCovered("Подарок маме купит Савелий", ["маме на подарок"], names)
    ).toBe(true);
    expect(
      paymentCovered("Савелий оплатит торт в субботу", ["торт"], names)
    ).toBe(true);
    for (const [text, paysFor] of [
      ["Савелий оплатит торт и автомобиль", ["торт"]],
      ["Савелий оплатит весь праздник", ["торт"]],
      ["Савелий оплатит маме квартиру", ["маме на подарок"]],
      ["Савелий оплатит половину подарка", ["маме на подарок"]],
      ["Савелий купит торт", []],
      ["Савелий заплатит за всё", ["я плачу"]],
      ["Савелий оплатит ПК", ["я плачу"]],
      ["Савелий оплатит купе", ["я плачу"]],
      ["Савелий оплатит мартини", ["я плачу"]],
    ] as const)
      expect(paymentCovered(text, [...paysFor], names)).toBe(false);
    // A promise of nothing named covers only a promise of nothing named.
    expect(paymentCovered("Савелий заплатит", ["я плачу"], names)).toBe(true);
    // «Я плачу» without for what covers a promise of nothing named, and no
    // word of the errand: not «ужин» of «договорись об ужине, я плачу».
    expect(paymentCovered("Савелий оплатит ужин", ["я плачу"], names)).toBe(
      false
    );
    // «скинемся» pays with the other one: they may be the payer too.
    expect(paysTogether("скинемся с петей маме на подарок")).toBe(true);
    expect(paysTogether("я куплю торт")).toBe(false);
    expect(
      paymentCovered("Пётр скидывается на подарок", ["скинемся на подарок"], {
        ...names,
        together: true,
      })
    ).toBe(true);
  });

  it("reads every promise of a text, whatever its verb, with what belongs to it", () => {
    const names = ["Савелий", "Пётр"];
    expect(
      promisesIn(["Савелий оплатит торт, машину и билеты"], names)
    ).toEqual(["Савелий оплатит торт машину и билеты"]);
    expect(promisesIn(["Машину, торт Савелий оплатит"], names)).toEqual([
      "Машину торт Савелий оплатит",
    ]);
    expect(
      promisesIn(["Предлагаю так: Пётр скидывается, Савелий покупает."], names)
    ).toEqual(["Пётр скидывается", "Савелий покупает"]);
    expect(promisesIn(["Савелий — покупает подарок"], names)).toEqual([
      "Савелий покупает подарок",
    ]);
    expect(promisesIn(["Пётр за, кто из вас купит?"], names)).toEqual([]);
    expect(promisesIn(["Торт за ним", "Ужин на Савелии"], names)).toEqual([
      "Торт за ним",
      "Ужин на Савелии",
    ]);
    expect(promisesIn(["Пётр придёт в платье на берег"], names)).toEqual([]);
    expect(promisesIn(["Кому угодно Савелий купит автомобиль"], names)).toEqual(
      ["Кому угодно Савелий купит автомобиль"]
    );
    expect(
      promisesIn(["Савелий оплатит торт, автомобиль для Петра"], names)
    ).toEqual(["Савелий оплатит торт автомобиль для Петра"]);
    for (const text of [
      "Вы с Савелием скинетесь на шубу",
      "Савелий доплатит за шубу",
      "Шуба маме — с Савелия",
      "Савелий раскошелится на шубу",
      "Савелий профинансирует поездку",
    ])
      expect(promisesIn([text], names)).toHaveLength(1);
    expect(promisesIn(["купе"], names)).toEqual([]);
    expect(
      promisesIn(["Савелий согласен. Кому угодно он купит автомобиль"], names)
    ).toEqual(["Кому угодно он купит автомобиль"]);
    expect(
      promisesIn(
        ["Савелий оплатит торт, автомобиль для Николь"],
        ["Савелий", "Николь"]
      )
    ).toEqual(["Савелий оплатит торт автомобиль для Николь"]);
    expect(promisesIn(["Савелий расплатится за шубу"], names)).toHaveLength(1);
  });

  it("hears what the owner says the other person pays for", () => {
    expect(
      peerPaysSaid(ownerText(["Да, скинусь по 3000, а купит пусть Савелий"]))
    ).toEqual(["купит пусть савелий"]);
    expect(peerPaysSaid(ownerText(["пусть Борис платит за мясо"]))).toEqual([
      "пусть борис платит за мясо",
    ]);
    for (const text of [
      "Борис хочет, чтобы я купил",
      "Петя написал: «пусть Савелий купит»",
      "может, Савелий купит?",
      "Савелий не купит",
      "я куплю торт",
    ])
      expect(peerPaysSaid(ownerText([text]))).toEqual([]);
  });

  it("covers the other person's promise only as the owner's words gave it, and none that says the owner pays", () => {
    const names = { peer: "Савелий", self: "Пётр" };
    const goal =
      "Савелий хочет скинуться с Петром маме на подарок; кто покупает?";
    const given = ["купит пусть савелий"];
    expect(
      peerPaymentCovered("Савелий покупает подарок маме", given, names, goal)
    ).toBe(true);
    for (const text of [
      "Савелий, Пётр купит подарок",
      "Савелий, мой владелец купит подарок",
      "Савелий купит подарок и машину",
      "Борис купит подарок",
      "Савелию куплю подарок",
      "Савелию Пётр купит подарок",
      "Пётр и ты купите подарок",
    ])
      expect(peerPaymentCovered(text, given, names, goal)).toBe(false);
    expect(
      peerPaymentCovered("Савелий покупает подарок маме", [], names, goal)
    ).toBe(false);
    expect(
      peerPaymentCovered("Ты купишь подарок маме?", given, names, goal)
    ).toBe(true);
  });
});

describe("meetingLength", () => {
  const start = "2026-10-31T19:00:00+03:00";

  it.each([
    ["в субботу в 19 ровно на час", 60],
    ["кофе минут на 40", 40],
    ["в 19 до 20:30", 90],
    ["в 7 вечера до 9", 120],
    ["на полчаса забегу", 30],
    ["посидим часа на 3", 180],
    ["на 0,33 часа", 20],
    ["на 30 часов", 1440],
  ])("reads the length the owner named: %s", (text, minutes) => {
    expect(meetingLength(ownerText([text]), start, moscow)).toBe(minutes);
  });

  it("names no length the owner did not say", () => {
    expect(meetingLength(ownerText(["в субботу в 19"]), start, moscow)).toBe(
      null
    );
  });
});

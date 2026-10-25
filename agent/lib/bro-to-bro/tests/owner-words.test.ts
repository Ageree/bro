import { describe, expect, it } from "vitest";
import {
  homeLike,
  namedAmounts,
  namedItems,
  namedPlace,
  namedTime,
  namedSums,
  ownerText,
  paymentCovered,
  paymentsSaid,
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
  });
});

describe("paymentsSaid", () => {
  it.each([
    ["скинемся маме на подарок", ["маме на подарок"]],
    ["я куплю торт", ["торт"]],
    ["готов дать 3000 на цветы", ["3000 на цветы"]],
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
    "я плачу",
    "торт я куплю",
  ])("hears no promise of the owner's in: %s", (text) => {
    expect(paymentsSaid(ownerText([text]))).toEqual([]);
  });

  it("covers a promise only of what the owner said they pay for", () => {
    expect(paymentCovered("Савелий купит торт", ["торт"])).toBe(true);
    expect(paymentCovered("Савелий оплатит весь праздник", ["торт"])).toBe(
      false
    );
    expect(
      paymentCovered("Савелий оплатит маме квартиру", ["маме на подарок"])
    ).toBe(false);
  });
});

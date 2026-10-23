import { describe, expect, it } from "vitest";
import kidPartyDetails from "../../docs/cards/examples/kid-party-details.json";
import { secretAsked, secretInAnswer } from "./safety";
import { cardSchema } from "./schema";

const party = cardSchema.parse(kidPartyDetails);

function askingFor(label: string, hint?: string) {
  return cardSchema.parse({
    actions: [{ label: "Отправить", submit: "send" }],
    blocks: [
      { text: "Уточните", type: "text" },
      { hint, id: "answer", input: "text", label, type: "field" },
    ],
    title: "Вопрос",
  });
}

describe("what a card never asks", () => {
  it.each([
    ["Пароль от личного кабинета", undefined, "secret"],
    ["Код из СМС", undefined, "secret"],
    ["CVC", undefined, "secret"],
    ["Номер карты", undefined, "card-number"],
    ["Серия и номер паспорта", undefined, "document"],
    ["Ваш номер", "СНИЛС, 11 цифр", "document"],
  ] as const)("names a field that asks for «%s»", (label, hint, kind) => {
    expect(secretAsked(askingFor(label, hint))).toEqual({
      kind,
      path: "blocks[1]",
    });
  });

  it.each(["Код брони", "Промокод", "Код домофона", "Номер заказа"])(
    "lets a field ask for «%s»",
    (label) => {
      expect(secretAsked(askingFor(label))).toBeUndefined();
    }
  );
});

/** The party card's answer with this typed into «Что ещё учесть». */
const answer = (wish: string) => ({
  action: "plan",
  values: { budget: 30000, kids: 10, wish },
});

describe("what an answer may not carry", () => {
  it.each([
    ["a card number", "оплатите картой 4111 1111 1111 1111", "card-number"],
    ["a password", "пароль: Kot2024!", "secret"],
    ["a SNILS", "СНИЛС 112-233-445 95", "document"],
  ] as const)("finds %s in a typed field, by its id", (_case, wish, kind) => {
    expect(secretInAnswer(party, answer(wish))).toEqual({ id: "wish", kind });
  });

  it("lets a phone, an order number and the numbers of the card's own fields through", () => {
    expect(
      secretInAnswer(party, answer("звонить на +7 999 123-45-67"))
    ).toBeUndefined();
    expect(
      secretInAnswer(party, answer("заказ 1234567890123"))
    ).toBeUndefined();
  });
});

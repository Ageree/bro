import { describe, expect, it } from "vitest";
import { cardSchema } from "@shared/cards/schema";
import { checkCard } from "../tools";

const buttonCard = (label: string) =>
  cardSchema.parse({
    title: "Выбор отеля",
    blocks: [
      {
        type: "text",
        text: "Выбор только готовит бронь. Оплата и подтверждение брони — после «да» в чате.",
      },
    ],
    actions: [{ label, submit: "prepare" }],
  });

describe("a card button's promise", () => {
  it.each([
    "Оплатить",
    "Заплатить 500 ₽",
    "Купить",
    "Перевести",
    "Выбрать и купить",
  ])("refuses an explicit payment button: %s", (label) => {
    expect(
      checkCard(buttonCard(label), "Выбери отель", "Nothing changed").refusal
    ).toMatchObject({ status: "refused" });
  });

  it.each([
    "Выбрать",
    "Выбрать и забронировать",
    "Заказать выбранное",
    "Забронировать",
    "Подготовить бронь",
  ])("keeps selection and preparation buttons: %s", (label) => {
    expect(
      checkCard(buttonCard(label), "Выбери отель", "Nothing changed").card
    ).toBeDefined();
  });
});

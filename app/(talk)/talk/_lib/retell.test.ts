import { describe, expect, it } from "vitest";
import { asksPerson, spokenText } from "./retell";

describe("Bro's message as the voice gets it", () => {
  it("keeps the words of links and drops pictures, addresses and markup", () => {
    expect(
      spokenText(
        "**Нашёл:** [Сушиман](https://example.com/a) ![фото](/artifacts/x.png) и https://example.com/b"
      )
    ).toBe("Нашёл: Сушиман и (ссылка в чате)");
  });

  it("sends a long message's start and leaves the rest to the chat", () => {
    const text = spokenText("слово ".repeat(400));

    expect(text.length).toBeLessThan(1300);
    expect(text).toMatch(/\(дальше — в чате\)$/u);
  });

  it("knows a message that waits on the person's answer, wherever the question stands", () => {
    // 20.10: «Что берём?» stood mid-message, and the owner's choice never
    // reached Bro.
    expect(
      asksPerson(
        "Нашёл: филе индейки, 589 ₽. Что берём? Могу и то и другое, домой на Мичуринский."
      )
    ).toBe(true);
    expect(asksPerson("Заказал, привезут к 19:00.")).toBe(false);
    expect(asksPerson("Вот он: https://lavka.yandex.ru/good?id=1")).toBe(false);
  });
});

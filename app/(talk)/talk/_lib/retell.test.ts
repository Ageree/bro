import { describe, expect, it } from "vitest";
import { asksPerson, notePieces, quietNotePieces, spokenText } from "./retell";

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

  it("splits a long note into whole lines within an append's limit", () => {
    const lines = Array.from(
      { length: 40 },
      (_, index) => `- вт 28.10 ${String(index)}:00 «Встреча ${String(index)}»`
    );
    const pieces = notePieces(lines.join("\n"), 200);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= 200)).toBe(true);
    expect(pieces.join("\n")).toBe(lines.join("\n"));
  });

  it("leads every piece of a silent note with the line that keeps the voice from reading it out", () => {
    const pieces = quietNotePieces(
      Array.from(
        { length: 30 },
        (_, index) =>
          `- вт 28.10 ${String(index)}:00 «Встреча с командой по проекту ${String(index)}»`
      ).join("\n")
    );

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces)
      expect(piece).toMatch(/^Справка на потом: вслух её не пересказывай/u);
  });
});

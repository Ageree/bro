import { describe, expect, it } from "vitest";
import { spokenText } from "./retell";

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
});

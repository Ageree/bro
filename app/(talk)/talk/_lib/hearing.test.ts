import { describe, expect, it } from "vitest";
import { voiceLinePattern } from "@shared/voice/marker";
import { forQuickAnswer, Hearing, withQuickAnswers } from "./hearing";

function heard(hearing: Hearing, text: string, startMs: number) {
  hearing.hear({ text, startMs, endMs: startMs + 300 });
}

function spoke(hearing: Hearing, text: string, startMs: number) {
  hearing.speak({ text, startMs, endMs: startMs + 1000 });
}

describe("the words the voice hands to Bro", () => {
  it("carry a request the voice asked about in between as one", () => {
    const hearing = new Hearing();
    heard(hearing, "Напомни", 0);
    heard(hearing, " мне завтра", 300);
    spoke(hearing, "О чём напомнить?", 1500);
    heard(hearing, "Позвонить маме", 4000);
    spoke(hearing, "Сейчас поставлю.", 4600);

    expect(hearing.takeRequest()).toBe(
      "Напомни мне завтра\n(ты: «О чём напомнить?»)\nПозвонить маме"
    );
  });

  it("keep what the person said over the voice and after a pause", () => {
    const hearing = new Hearing();
    spoke(hearing, "Нашёл три места…", 0);
    heard(hearing, "Стоп, лучше японское", 600);
    heard(hearing, "и чтобы недалеко", 3000);

    expect(hearing.takeRequest()).toBe(
      "Стоп, лучше японское\nи чтобы недалеко"
    );
  });

  it("are nothing when the person said nothing since the last request", () => {
    const hearing = new Hearing();
    heard(hearing, "Найди ресторан", 0);
    hearing.takeRequest();
    spoke(hearing, "Сейчас гляну.", 800);

    expect(hearing.hasRequest()).toBe(false);
    expect(hearing.takeRequest()).toBeUndefined();
    heard(hearing, "А японский?", 3000);
    expect(hearing.hasRequest()).toBe(true);
  });
});

describe("the words going to Bro after quick answers", () => {
  it("carry the last two quick answers before them, each as one voice line", () => {
    expect(
      withQuickAnswers("Напомни утром взять зонт, если так", [
        { words: "Какой курс доллара?", answer: "Восемьдесят с половиной." },
        { words: "Какая погода завтра?", answer: "Плюс восемь,\nдождь." },
        { words: "А в Казани?", answer: "Плюс шесть, сухо." },
      ])
    ).toBe(
      "(ты: «уже ответил голосом на «Какая погода завтра?»: Плюс восемь, дождь.»)\n(ты: «уже ответил голосом на «А в Казани?»: Плюс шесть, сухо.»)\nНапомни утром взять зонт, если так"
    );
    expect(withQuickAnswers("Позвони маме", [])).toBe("Позвони маме");
  });

  it("leave a «да» to Bro's question nothing but «да» once the voice's lines are struck out", () => {
    // As the readers of consent read it (`spokenWords`): «да» after the
    // weather still pays.
    expect(
      withQuickAnswers("да", [
        { words: "Какая погода завтра?", answer: "Плюс восемь,\nдождь." },
      ])
        .replaceAll(voiceLinePattern, "")
        .trim()
    ).toBe("да");
  });

  it("give the quick answer Bro's last message to read the words by", () => {
    expect(
      forQuickAnswer(
        "А какая там погода?",
        [],
        "Нашёл три отеля в Сочи.\nКакой берём?"
      )
    ).toBe("(ты: «Нашёл три отеля в Сочи. Какой берём?»)\nА какая там погода?");
  });
});

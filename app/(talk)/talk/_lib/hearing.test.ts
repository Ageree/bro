import { describe, expect, it } from "vitest";
import { Hearing } from "./hearing";

function heard(hearing: Hearing, text: string, startMs: number) {
  hearing.hear({ text, startMs, endMs: startMs + 300 });
}

describe("the words the voice hands to Bro", () => {
  it("are the request after the voice's own answer, without the small talk before it", () => {
    const hearing = new Hearing();
    heard(hearing, "Как", 0);
    heard(hearing, " дела?", 300);
    hearing.speak({ text: "Отлично!", startMs: 1500, endMs: 2500 });
    heard(hearing, "Что у меня", 4000);
    heard(hearing, " завтра?", 4300);

    expect(hearing.takeRequest()).toBe("Что у меня завтра?");
  });

  it("keep what the person said over the voice before going on", () => {
    const hearing = new Hearing();
    hearing.speak({ text: "Нашёл три места…", startMs: 0, endMs: 3000 });
    heard(hearing, "Стоп,", 2000);
    heard(hearing, " лучше японское", 2600);

    expect(hearing.takeRequest()).toBe("Стоп, лучше японское");
  });

  it("are nothing when the person said nothing since the last request", () => {
    const hearing = new Hearing();
    heard(hearing, "Найди ресторан", 0);
    hearing.takeRequest();
    hearing.speak({ text: "Сейчас гляну.", startMs: 800, endMs: 1500 });

    expect(hearing.takeRequest()).toBeUndefined();
  });
});

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  chosenFormOfAddress,
  messageLanguage,
  personLanguage,
  replyDirective,
} from "@agent/lib/delivery/language";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { defaultFormOfAddress } from "@shared/chat/form-of-address";

describe("messageLanguage", () => {
  it.each([
    ["find a dinner spot for four tomorrow at 7:30", "en"],
    ["triage my inbox", "en"],
    ["найди, где поужинать", "ru"],
    ["что лучше, iPhone или Pixel?", "ru"],
    ["[голосовое] купи молоко", "ru"],
  ] as const)("reads %j as %s", (text, language) => {
    expect(messageLanguage(text)).toBe(language);
  });

  it.each(["ok", "👍", "https://example.com/page", "7:30"])(
    "finds no language in %j",
    (text) => {
      expect(messageLanguage(text)).toBeUndefined();
    }
  );
});

describe("personLanguage", () => {
  it("follows the latest message the person wrote", () => {
    expect(
      personLanguage([
        person("привет, найди ресторан"),
        assistant("Нашёл"),
        person("thanks, and what about tomorrow?"),
      ])
    ).toBe("en");
  });

  it("skips context, memory and a browser report", () => {
    expect(
      personLanguage([
        person("what car should I buy?"),
        tagged("context.turn", "Пометка: память человека по-русски"),
        tagged("memory.recall", "Предпочитает общаться по-русски"),
        person("Browser run run_1 finished.\n\nErrand: найди машину"),
      ])
    ).toBe("en");
  });

  it("skips a proactive or scheduled report Bro wrote to itself", () => {
    expect(
      personLanguage([
        person("найди мне рейс в Казань"),
        person(
          `${backgroundTurnMarker}\n\nYour own background check of the person's mail and calendar found something.`
        ),
        person("ок"),
      ])
    ).toBe("ru");
  });

  it("keeps the language through a reply without one", () => {
    expect(personLanguage([person("find me a flight"), person("ok")])).toBe(
      "en"
    );
  });
});

describe("replyDirective", () => {
  const formal = { formal: true, name: null };

  it("leaves requested translations in the language asked for", () => {
    expect(
      replyDirective({ formOfAddress: defaultFormOfAddress, language: "ru" })
    ).toContain("Текст, который человек попросил на другом языке (перевод");
    expect(
      replyDirective({ formOfAddress: defaultFormOfAddress, language: "en" })
    ).toContain("Text the person asked for in another language (a translation");
  });

  it("makes Bro speak of himself in the masculine in Russian", () => {
    const note = replyDirective({
      formOfAddress: defaultFormOfAddress,
      language: "ru",
    });
    expect(note).toMatch(/^Язык ответа в этом ходе — русский/u);
    expect(note).toContain("О себе пиши в мужском роде: «сделал»");
    expect(note).toContain("а не «сделала»");
    // The voice is Bro's own, not the one of a letter written for the person.
    expect(note).toContain("письма и тексты, которые пишешь от его имени");
  });

  it("keeps «ты» unless the person asked for «вы»", () => {
    const informal = replyDirective({
      formOfAddress: defaultFormOfAddress,
      language: "ru",
    });
    expect(informal).toContain("К человеку обращайся на «ты»");

    const note = replyDirective({ formOfAddress: formal, language: "ru" });
    expect(note).toContain("Человек просил обращаться к нему на «вы»");
    expect(note).toContain("без «ты»");
    expect(note).not.toContain("К человеку обращайся на «ты»");
  });

  it("calls the person by the name they chose", () => {
    const formOfAddress = { formal: false, name: "Саша" };
    expect(replyDirective({ formOfAddress, language: "ru" })).toContain(
      "по имени «Саша»"
    );
    expect(replyDirective({ formOfAddress, language: "en" })).toContain(
      "Call the person «Саша»"
    );
  });

  it("holds the Russian voice when the language is unclear", () => {
    const note = replyDirective({ formOfAddress: formal, language: undefined });
    expect(note).toMatch(/^Когда пишешь человеку по-русски:/u);
    expect(note).toContain("в мужском роде");
    expect(note).toContain("на «вы»");
    expect(note).not.toContain("Язык ответа");
  });

  it("says the reply is out once the turn delivered one", () => {
    // Read after a delivered reply, the plain note looked like a new request:
    // one benchmark turn answered «перешёл на «вы»» six times.
    const note = replyDirective({
      answered: true,
      formOfAddress: formal,
      language: "ru",
    });
    expect(note).toMatch(
      /^Ответ на последнее сообщение человека в этом ходе уже доставлен\./u
    );
    expect(note).toContain("не замечание к отправленному");
    expect(note).toContain("на «вы»");
    expect(
      replyDirective({ answered: true, formOfAddress: formal, language: "en" })
    ).toMatch(/^Your reply to the person's latest message has already/u);
    expect(
      replyDirective({ formOfAddress: formal, language: "ru" })
    ).not.toContain("уже доставлен");
  });

  it("does not end a turn that still owes a card step (review #22)", () => {
    // A booked report's calendar card comes after its message; «end the
    // turn», read last, left it uncreated.
    for (const language of ["en", "ru"] as const) {
      const ends = replyDirective({
        answered: true,
        formOfAddress: formal,
        language,
      });
      const owes = replyDirective({
        answered: true,
        formOfAddress: formal,
        language,
        stepOwed: true,
      });
      expect(ends).toMatch(/end the turn|закончи ход/u);
      expect(owes).not.toMatch(/end the turn|закончи ход/u);
    }
  });

  it("gives an English reply no Russian grammar rules", () => {
    const note = replyDirective({ formOfAddress: formal, language: "en" });
    expect(note).toMatch(/^Reply language for this turn: English\./u);
    expect(note).not.toMatch(/\p{Script=Cyrillic}/u);
  });
});

describe("chosenFormOfAddress", () => {
  it("says nothing until the person chose", () => {
    expect(chosenFormOfAddress(defaultFormOfAddress)).toBeUndefined();
  });

  it("states «вы» and the chosen name", () => {
    const chosen = chosenFormOfAddress({ formal: true, name: "Мария" });
    expect(chosen).toContain("на «вы»");
    expect(chosen).toContain("по имени «Мария»");
  });
});

function person(text: string): ModelMessage {
  return tagged("user", text);
}

function tagged(kind: string, text: string): ModelMessage {
  return Object.assign({ content: text, role: "user" as const }, { kind });
}

function assistant(text: string): ModelMessage {
  return { content: text, role: "assistant" };
}

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  messageLanguage,
  personLanguage,
  replyLanguageDirective,
} from "@agent/lib/delivery/language";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

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

describe("replyLanguageDirective", () => {
  it("leaves requested translations in the language asked for", () => {
    expect(replyLanguageDirective("ru")).toContain(
      "Текст, который человек попросил на другом языке (перевод"
    );
    expect(replyLanguageDirective("en")).toContain(
      "Text the person asked for in another language (a translation"
    );
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

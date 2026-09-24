import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  messageLanguage,
  personLanguage,
  wrongReplyLanguage,
} from "@agent/lib/delivery/language";

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

  it("keeps the language through a reply without one", () => {
    expect(personLanguage([person("find me a flight"), person("ok")])).toBe(
      "en"
    );
  });
});

describe("wrongReplyLanguage", () => {
  it("catches Russian sent to an English speaker", () => {
    expect(
      wrongReplyLanguage("Нашёл отличное место на Тверской, столик есть.", "en")
    ).toBe(true);
    expect(
      wrongReplyLanguage("Pushkin café, table for four at 7:30 PM.", "en")
    ).toBe(false);
  });

  it("catches English sent to a Russian speaker, not a brand name", () => {
    expect(
      wrongReplyLanguage(
        "Found a great spot on Tverskaya with a free table.",
        "ru"
      )
    ).toBe(true);
    expect(wrongReplyLanguage("iPhone 17 Pro Max", "ru")).toBe(false);
    expect(wrongReplyLanguage("Бери Pixel 10 Pro", "ru")).toBe(false);
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

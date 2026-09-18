import { describe, expect, it } from "vitest";
import { toIMessageBold, toIMessageText } from "../compile";
import { inboxSummary } from "./inbox-summary";

describe("iMessage text compilation", () => {
  it("leaves plain text alone", () => {
    expect(toIMessageText("просто текст")).toBe("просто текст");
  });

  it("maps Latin to sans-serif bold and leaves Cyrillic unstyled", () => {
    expect(toIMessageBold("hello")).not.toBe("hello");
    expect(toIMessageBold("От")).toBe("От");
    expect(toIMessageText("**hello**")).toBe(toIMessageBold("hello"));
  });

  it("marks a Cyrillic field label it cannot bold", () => {
    expect(toIMessageText("**От:** Ageree")).toBe("▸ От: Ageree");
  });

  it("flattens a markdown link into a caption and its URL", () => {
    expect(
      toIMessageText("[Просмотреть сообщение](https://mail.google.com/x)")
    ).toBe("Просмотреть сообщение\nhttps://mail.google.com/x");
    expect(toIMessageText("[x](https://a.b/c)")).toBe("x\nhttps://a.b/c");
    expect(
      toIMessageText("[Doc](https://en.wikipedia.org/wiki/Function_(math))")
    ).toContain("(math)");
    expect(toIMessageText("**[Открыть](https://example.com/a)**")).toBe(
      "Открыть\nhttps://example.com/a"
    );
  });

  it("strips inline code and bold markers", () => {
    expect(toIMessageText("Пиши `browser_task` и **жди**")).toBe(
      "Пиши browser_task и жди"
    );
  });

  it("rewrites bullets and headings", () => {
    expect(toIMessageText("- один\n- два")).toBe("• один\n• два");
    expect(toIMessageText("# Заголовок\nтекст")).toBe("Заголовок\nтекст");
  });

  it("drops container fences and non-iMessage markup", () => {
    expect(toIMessageText(":::rich\nкарточка")).toBe("карточка");
    expect(toIMessageText(":::rich\nContent\n:::\nafter")).toBe(
      "Content\n\nafter"
    );
    expect(toIMessageText(":::rich\nContent\n:::")).not.toContain(":::");
    expect(toIMessageText("++черта++")).toBe("черта");
    expect(toIMessageText("||спойлер||")).toBe("спойлер");
    expect(toIMessageText(">! скрыто\n>! ещё")).toBe("скрыто\nещё");
    expect(
      toIMessageText(
        "Смотри\n\n:::buttons\n[Открыть](https://example.com/z)\n:::"
      )
    ).toBe("Смотри\n\nОткрыть\nhttps://example.com/z");
  });

  it("turns hidden media markdown into caption and URL lines", () => {
    expect(toIMessageText("!![обложка](https://img.example/s.jpg)")).toBe(
      "обложка\nhttps://img.example/s.jpg"
    );
  });

  it("unwraps autolinks and code fences", () => {
    expect(toIMessageText("<notifications@github.com>")).toBe(
      "notifications@github.com"
    );
    expect(toIMessageText("```\ncode\n```")).toBe("code");
  });

  it("compiles an inbox summary without leaving markup behind", () => {
    const compiled = toIMessageText(inboxSummary);

    expect(compiled).not.toContain("**");
    expect(compiled).not.toContain("](");
    expect(compiled).toContain("▸ От: Ageree");
    expect(compiled).toContain("▸ Тема:");
    expect(compiled).toContain(
      "https://mail.google.com/mail/u/0/#inbox/1a03fcf0f1a8bcff"
    );
    expect(compiled).toContain("notifications@github.com");
    expect(toIMessageText(compiled)).toBe(compiled);
  });
});

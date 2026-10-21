import { describe, expect, it } from "vitest";
import { toIMessageBold, toIMessageText } from "../compile";
import { inboxSummary } from "./inbox-summary";

describe("iMessage text compilation", () => {
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

  it("keeps a link's word in the sentence and its address on the next line", () => {
    expect(
      toIMessageText(
        "Курс почти не изменился, условий пока нет ([Интерфакс](https://www.interfax.ru/amp/1123917)). Плюс он заявил…"
      )
    ).toBe(
      "Курс почти не изменился, условий пока нет (Интерфакс). Плюс он заявил…\nhttps://www.interfax.ru/amp/1123917"
    );
    expect(
      toIMessageText(
        "• [Король и Шут](https://a.b/kish) — ЦСКА Арена, 31 октября"
      )
    ).toBe("• Король и Шут — ЦСКА Арена, 31 октября\nhttps://a.b/kish");
    // The closing full stop belongs to the sentence, not to the address.
    expect(
      toIMessageText(
        "Прогноз — [Погода Mail](https://pogoda.mail.ru/moskva/22-october/)."
      )
    ).toBe("Прогноз — Погода Mail.\nhttps://pogoda.mail.ru/moskva/22-october/");
    expect(toIMessageText("Источник: [Интерфакс](https://a.b/1)")).toBe(
      "Источник: Интерфакс\nhttps://a.b/1"
    );
  });

  it("puts the address of each list item right under that item", () => {
    expect(
      toIMessageText(
        "- [Король и Шут](https://a.b/1) — ЦСКА\n- [Куок](https://a.b/2) — Крокус"
      )
    ).toBe(
      "• Король и Шут — ЦСКА\nhttps://a.b/1\n• Куок — Крокус\nhttps://a.b/2"
    );
  });

  it("names each address when one line holds several links", () => {
    expect(
      toIMessageText(
        "Курс упал ([Интерфакс](https://a.b/1), [ТАСС](https://a.b/2)), аналитики ждут."
      )
    ).toBe(
      "Курс упал (Интерфакс, ТАСС), аналитики ждут.\nИнтерфакс: https://a.b/1\nТАСС: https://a.b/2"
    );
    expect(
      toIMessageText(
        "Подробнее у [Интерфакса](https://a.b/1) и [ТАСС](https://a.b/2)."
      )
    ).toBe(
      "Подробнее у Интерфакса и ТАСС.\nИнтерфакса: https://a.b/1\nТАСС: https://a.b/2"
    );
  });

  it("turns a line that is only a list of links into name — address lines", () => {
    expect(
      toIMessageText(
        "Ссылки: [Король и Шут](https://a.b/1), [Куок](https://a.b/2), [Halloween Fest](https://a.b/3)."
      )
    ).toBe(
      "Ссылки:\nКороль и Шут — https://a.b/1\nКуок — https://a.b/2\nHalloween Fest — https://a.b/3"
    );
    expect(
      toIMessageText(
        "**Источники:** [Интерфакс](https://a.b/1); [ТАСС](https://a.b/2)."
      )
    ).toBe("Источники:\nИнтерфакс — https://a.b/1\nТАСС — https://a.b/2");
    expect(
      toIMessageText("[Интерфакс](https://a.b/1) и [ТАСС](https://a.b/2)")
    ).toBe("Интерфакс — https://a.b/1\nТАСС — https://a.b/2");
    expect(
      toIMessageText(
        "Источники: [Интерфакс](https://a.b/1), [Интерфакс](https://a.b/1)"
      )
    ).toBe("Источники:\nИнтерфакс — https://a.b/1");
  });

  it("does not take a sentence or a list item for a list of links", () => {
    expect(
      toIMessageText(
        "Вот что нашёл по теме, читай [А](https://a.b/1) и [Б](https://a.b/2)."
      )
    ).toBe(
      "Вот что нашёл по теме, читай А и Б.\nА: https://a.b/1\nБ: https://a.b/2"
    );
    expect(toIMessageText("- [А](https://a.b/1), [Б](https://a.b/2)")).toBe(
      "• А, Б\nА: https://a.b/1\nБ: https://a.b/2"
    );
  });

  it("keeps an address once and inline when the link text is the address", () => {
    expect(toIMessageText("Тут [https://a.b/c](https://a.b/c) всё")).toBe(
      "Тут https://a.b/c всё"
    );
    expect(
      toIMessageText("Так [А](https://a.b/1) и ещё раз [А](https://a.b/1).")
    ).toBe("Так А и ещё раз А.\nhttps://a.b/1");
  });

  it("keeps the address out of the emphasis around its link", () => {
    expect(toIMessageText("**[Open](https://a.b/c)**")).toBe(
      `${toIMessageBold("Open")}\nhttps://a.b/c`
    );
  });

  it("keeps the blank lines between paragraphs", () => {
    expect(
      toIMessageText(
        "Первое: [А](https://a.b/1).\n\nВторое: [Б](https://a.b/2).\n\nТретье."
      )
    ).toBe("Первое: А.\nhttps://a.b/1\n\nВторое: Б.\nhttps://a.b/2\n\nТретье.");
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

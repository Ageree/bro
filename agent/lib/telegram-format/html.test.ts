import { describe, expect, it } from "vitest";
import {
  splitTelegramHtml,
  splitTelegramPlain,
  telegramHtmlToPlain,
  telegramMessageTextMaxLength,
  toTelegramHtml,
} from "./html";

describe("Telegram HTML conversion", () => {
  it("escapes the characters Telegram parses as markup", () => {
    expect(toTelegramHtml("5 < 6 & 7 > 6 <b>not a tag</b>")).toBe(
      "5 &lt; 6 &amp; 7 &gt; 6 &lt;b&gt;not a tag&lt;/b&gt;"
    );
  });

  it("converts bold, italic, and inline code", () => {
    expect(toTelegramHtml("**Done** in _one_ `git push`")).toBe(
      "<b>Done</b> in <i>one</i> <code>git push</code>"
    );
  });

  it("leaves snake_case identifiers alone", () => {
    expect(toTelegramHtml("run link_telegram now")).toBe(
      "run link_telegram now"
    );
  });

  it("keeps markdown syntax inside code spans literal", () => {
    expect(toTelegramHtml("use `**not bold**` here")).toBe(
      "use <code>**not bold**</code> here"
    );
  });

  it("renders a fenced block as preformatted text", () => {
    expect(toTelegramHtml("Try:\n```sh\npnpm check < log\n```")).toBe(
      "Try:\n<pre>pnpm check &lt; log</pre>"
    );
  });

  it("converts a markdown link into an anchor", () => {
    expect(
      toTelegramHtml("See [the run](https://example.com/a?x=1&y=2).")
    ).toBe('See <a href="https://example.com/a?x=1&amp;y=2">the run</a>.');
  });

  it("does not emphasize underscores inside a link target", () => {
    expect(toTelegramHtml("[a](https://example.com/a_b_c)")).toBe(
      '<a href="https://example.com/a_b_c">a</a>'
    );
  });

  it("turns dash lists into bullets", () => {
    expect(toTelegramHtml("Plan:\n- first\n- **second**")).toBe(
      "Plan:\n• first\n• <b>second</b>"
    );
  });
});

describe("Telegram message splitting", () => {
  it("keeps a short message as one part", () => {
    expect(splitTelegramHtml("short")).toEqual(["short"]);
  });

  it("prefers a newline boundary", () => {
    const head = "a".repeat(telegramMessageTextMaxLength - 10);
    const parts = splitTelegramHtml(`${head}\n${"b".repeat(200)}`);

    expect(parts).toEqual([head, "b".repeat(200)]);
  });

  it("falls back to a space boundary", () => {
    const head = "a".repeat(telegramMessageTextMaxLength - 10);
    const parts = splitTelegramHtml(`${head} ${"b".repeat(200)}`);

    expect(parts).toEqual([head, "b".repeat(200)]);
  });

  it("never cuts a message inside a tag pair", () => {
    const filler = "a".repeat(telegramMessageTextMaxLength - 20);
    const parts = splitTelegramHtml(`${filler} <b>${"b".repeat(60)}</b> tail`);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(filler);
    expect(parts[1]).toBe(`<b>${"b".repeat(60)}</b> tail`);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(telegramMessageTextMaxLength);
    }
  });

  it("hard-splits a single unbroken run", () => {
    const parts = splitTelegramHtml(
      "a".repeat(telegramMessageTextMaxLength + 5)
    );

    expect(parts).toEqual(["a".repeat(telegramMessageTextMaxLength), "aaaaa"]);
  });

  it("escapes markup around a word link and quotes inside its URL", () => {
    expect(
      toTelegramHtml(
        'Цена <5000 & выше: [карточка "A&B"](https://a.ru/p?q="x"&b=1)'
      )
    ).toBe(
      'Цена &lt;5000 &amp; выше: <a href="https://a.ru/p?q=&quot;x&quot;&amp;b=1">карточка "A&amp;B"</a>'
    );
  });

  it("keeps balanced parentheses in a link URL", () => {
    expect(
      toTelegramHtml("[Doc](https://en.wikipedia.org/wiki/Function_(math)) тут")
    ).toBe(
      '<a href="https://en.wikipedia.org/wiki/Function_(math)">Doc</a> тут'
    );
  });

  it("splits a long text of word links without cutting an anchor", () => {
    const line =
      "• [карточка товара номер 1234567890](https://mvideo.ru/products/televizor-1234567890?a=1&b=2) 49 990 ₽";
    const text = Array.from({ length: 80 }, () => line).join("\n");
    const chunks = splitTelegramHtml(toTelegramHtml(text));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(telegramMessageTextMaxLength);
      expect(chunk.match(/<a /gu)?.length).toBe(chunk.match(/<\/a>/gu)?.length);
    }
    expect(chunks.join("\n").match(/<a /gu)?.length).toBe(80);
  });

  it("drops emphasis markers from a link label", () => {
    expect(toTelegramHtml("[**Телевизор** __X__](https://a.ru/p)")).toBe(
      '<a href="https://a.ru/p">Телевизор X</a>'
    );
  });

  it("writes a rendered chunk as plain words and splits plain text", () => {
    expect(
      telegramHtmlToPlain(
        '<b>Итог</b>: <a href="https://a.ru/p?x=1&amp;y=&quot;2&quot;">карточка</a> 5 &lt; 6'
      )
    ).toBe('Итог: карточка: https://a.ru/p?x=1&y="2" 5 < 6');
    const chunks = splitTelegramPlain("слово ".repeat(1500));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(telegramMessageTextMaxLength);
    }
  });
});

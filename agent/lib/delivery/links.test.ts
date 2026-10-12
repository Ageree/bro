import { describe, expect, it } from "vitest";
import { withHttpsLinks, withVisibleLinks } from "./links";

describe("withHttpsLinks", () => {
  it("adds https:// to a bare address with a path (QA 12.10)", () => {
    expect(withHttpsLinks("вот mvideo.ru/products/televizor-30060123")).toBe(
      "вот https://mvideo.ru/products/televizor-30060123"
    );
  });

  it("adds https:// to the target of a markdown link", () => {
    expect(
      withHttpsLinks("вот [карточка товара](mvideo.ru/products/tv-1)")
    ).toBe("вот [карточка товара](https://mvideo.ru/products/tv-1)");
    expect(withHttpsLinks("[x](www.ozon.ru/product/5/?a=1)")).toBe(
      "[x](https://www.ozon.ru/product/5/?a=1)"
    );
  });

  it("is idempotent and keeps schemed targets, paths and images", () => {
    const text =
      "[a](https://a.ru/x) [b](http://b.ru/y) ![c](/artifacts/1) ![d](d.ru/i.png) https://e.ru/z";
    expect(withHttpsLinks(text)).toBe(text);
    expect(withHttpsLinks(withHttpsLinks("m.ru/a [t](m.ru/b)"))).toBe(
      "https://m.ru/a [t](https://m.ru/b)"
    );
  });

  it("leaves what is no address alone", () => {
    for (const text of [
      "файл report.pdf готов",
      "оценка 4.5/5",
      "mvideo.ru",
      "почта ivan@mail.ru/ok",
      "версия 1.2.3/4",
    ]) {
      expect(withHttpsLinks(text)).toBe(text);
    }
  });

  it("leaves false positives alone (reviewer cases)", () => {
    for (const text of [
      "Привет.Как/дела",
      "г.Москва/область",
      "см. node.js/docs",
      "файл report.pdf/x",
      "`mvideo.ru/products/1`",
      "```\ncurl mvideo.ru/p/1\n```",
      "[док](report.pdf)",
    ]) {
      expect(withHttpsLinks(text)).toBe(text);
    }
  });

  it("leaves an unpaired closing parenthesis out of the address", () => {
    expect(withHttpsLinks("(см. mvideo.ru/p/1)")).toBe(
      "(см. https://mvideo.ru/p/1)"
    );
    expect(withHttpsLinks("mvideo.ru/p/1)")).toBe("https://mvideo.ru/p/1)");
  });

  it("keeps trailing punctuation outside the address", () => {
    expect(withHttpsLinks("смотри mvideo.ru/p/1, потом mvideo.ru/p/2.")).toBe(
      "смотри https://mvideo.ru/p/1, потом https://mvideo.ru/p/2."
    );
  });

  it("keeps balanced parentheses in a target", () => {
    expect(withHttpsLinks("[Doc](en.wikipedia.org/wiki/Function_(math))")).toBe(
      "[Doc](https://en.wikipedia.org/wiki/Function_(math))"
    );
  });
});

describe("withVisibleLinks", () => {
  it("writes a word link as the word and its address", () => {
    expect(withVisibleLinks("вот [таблица](https://a.ru/s?d=c2VjcmV0)")).toBe(
      "вот таблица: https://a.ru/s?d=c2VjcmV0"
    );
    expect(withVisibleLinks("[https://a.ru/x](https://a.ru/x)")).toBe(
      "https://a.ru/x"
    );
  });

  it("shows an image inside a link as text, loading nothing", () => {
    expect(
      withVisibleLinks(
        "[![лого](https://evil.example/i.png?d=1)](https://evil.example/go)"
      )
    ).toBe("лого: https://evil.example/go");
  });

  it("shows a link with a title, in angle brackets, or by reference", () => {
    expect(withVisibleLinks('[a](https://x.ru/p "t")')).toBe(
      "a: https://x.ru/p"
    );
    expect(withVisibleLinks("[a](<https://x.ru/p q>)")).toBe(
      "a: https://x.ru/p q"
    );
    expect(
      withVisibleLinks(
        "см. [a][1] и [b]\n\n[1]: https://x.ru/p\n[b]: <https://y.ru/q> 'T'"
      )
    ).toBe("см. a: https://x.ru/p и b: https://y.ru/q");
  });

  it("shows an external image as text and keeps own files and artifacts", () => {
    const own = "https://bro.test/eve/v1/sandbox-files/1/c.png?sig=ok";
    expect(withVisibleLinks("![p](https://evil.example/i.png)")).toBe(
      "p: https://evil.example/i.png"
    );
    expect(
      withVisibleLinks(`![подпись](/artifacts/abc) ![c](${own})`, (url) =>
        url.startsWith("https://bro.test/")
      )
    ).toBe(`![подпись](/artifacts/abc) ![c](${own})`);
  });
});

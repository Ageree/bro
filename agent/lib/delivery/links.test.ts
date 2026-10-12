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

  it("leaves images and artifact paths", () => {
    const text = "![подпись](/artifacts/abc) ![p](https://a.ru/i.png)";
    expect(withVisibleLinks(text)).toBe(text);
  });
});

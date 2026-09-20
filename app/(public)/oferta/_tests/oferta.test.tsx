import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import OfertaPage, { metadata } from "@app/(public)/oferta/page";

describe("offer page", () => {
  const html = renderToStaticMarkup(createElement(OfertaPage));

  it("carries the legal text verbatim, with its numbering", () => {
    expect(html).toContain("Публичная оферта");
    expect(html).toContain("редакция от 27.08.2026");
    for (const heading of [
      "1. Общие положения",
      "2. Предмет",
      "3. Порядок оплаты и предоставления доступа",
      "4. Возвраты",
      "5. Ограничения и ответственность",
      "6. Персональные данные",
      "7. Прочее",
    ]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("ИП Соловьева Савелия Андреевича");
    // The landing no longer carries a tariff block, so clause 2.2 is where
    // the tariffs are published: it states them instead of linking away.
    expect(html).toContain("Бесплатный режим — до 30 сообщений в день");
    expect(html).toContain(
      "Платный тариф «Полный доступ» — 2000 ₽ за 30 календарных дней: до 500 сообщений в день"
    );
    expect(html).not.toContain("#pricing");
    expect(html).toContain("ИНН 780159467840 · ОГРНИП 325784700145981");
    expect(html).toContain('href="mailto:solsav1703@gmail.com"');
  });

  it("wears the masthead and stays out of search indexes", () => {
    expect(html).toContain('href="/"');
    expect(html).toContain(">bro.<");
    expect(metadata.title).toEqual({ absolute: "Публичная оферта — bro" });
    expect(metadata.robots).toEqual({ index: false });
  });
});

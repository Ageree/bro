import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage, { metadata } from "@app/(public)/privacy/page";

describe("privacy page", () => {
  const html = renderToStaticMarkup(createElement(PrivacyPage));

  it("names the operator, where the data lives and who gets it", () => {
    expect(html).toContain("ИП Соловьев Савелий Андреевич");
    expect(html).toContain("Selectel в России");
    for (const service of ["RouterAI", "Composio", "ElevenLabs", "AgentMail"]) {
      expect(html).toContain(service);
    }
    expect(html).not.toMatch(/Vercel|Neon/u);
    expect(html).toContain('href="mailto:solsav1703@gmail.com"');
    expect(html).toContain('href="/oferta"');
  });

  it("tells the beta reader the owner reads transcripts for 30 days", () => {
    expect(html).toContain("5. Бета");
    expect(html).toContain("владелец сервиса может читать");
    expect(html).toContain("хранятся 30 дн.");
    expect(html).toContain("коды, пароли и ссылки входа из них вырезаются");
  });

  it("stays out of search indexes", () => {
    expect(metadata.robots).toEqual({ index: false });
  });
});

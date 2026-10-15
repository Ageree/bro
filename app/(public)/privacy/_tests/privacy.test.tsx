import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
});

async function render(transcripts: "on" | "off") {
  vi.stubEnv("OWNER_TRANSCRIPTS", transcripts);
  vi.resetModules();
  const page = await import("@app/(public)/privacy/page");
  return {
    html: renderToStaticMarkup(createElement(page.default)),
    page,
  };
}

describe("privacy page", () => {
  it("names the operator, where the data lives and who gets it", async () => {
    const { html } = await render("off");
    expect(html).toContain("ИП Соловьев Савелий Андреевич");
    expect(html).toContain("Selectel в России");
    for (const service of [
      "RouterAI",
      "Composio",
      "ElevenLabs",
      "AgentMail",
      "Mail.ru и Яндекс",
      "Песочница для кода",
    ]) {
      expect(html).toContain(service);
    }
    expect(html).toContain("за пределами России");
    expect(html).not.toMatch(/Vercel|Neon/u);
    expect(html).toContain('href="mailto:solsav1703@gmail.com"');
    expect(html).toContain('href="/oferta"');
    expect(html).toContain("в течение 30 дней");
  });

  it("says how long a shared location is kept and what stays", async () => {
    const { html } = await render("off");
    expect(html).toContain("геопозиц");
    expect(html).toContain("до 90 дней");
    expect(html).toContain("остаётся в истории чатов");
  });

  it("promises owner reading only when transcripts are kept", async () => {
    const on = (await render("on")).html;
    expect(on).toContain("владелец сервиса может читать");
    expect(on).toContain("хранятся 30 дн.");
    expect(on).toContain("коды, пароли и ссылки входа из них вырезаются");

    const off = (await render("off")).html;
    expect(off).toContain("для владельца сервиса не сохраняются");
    expect(off).not.toContain("может читать вашу переписку");
  });

  it("is rendered per request and stays out of search indexes", async () => {
    const { page } = await render("off");
    expect(page.dynamic).toBe("force-dynamic");
    expect(page.metadata.robots).toEqual({ index: false });
  });
});

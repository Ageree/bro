import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { yooKassaConfigured } from "@db/services/yookassa";
import { imessageLink } from "@app/(public)/_components/write-bro";

const mocks = vi.hoisted(() => ({
  yooKassaConfigured: vi.fn<typeof yooKassaConfigured>(),
}));

vi.mock("@db/services/yookassa", () => ({
  yooKassaConfigured: mocks.yooKassaConfigured,
}));

/** A line no carrier assigns: the real one belongs in the environment. */
const broLine = "+12025550123";

// The page reads the line from the validated environment at import, so each
// render starts from a fresh module graph with the line this test wants.
const landingMarkup = async () => {
  const { default: LandingPage } = await import("@app/(public)/page");
  return renderToStaticMarkup(createElement(LandingPage));
};

// `vi.unstubAllEnvs` would take the shared test environment down with it, so
// each test restates the line it wants instead of clearing every stub.
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("IMESSAGE_PHONE_NUMBER", broLine);
  mocks.yooKassaConfigured.mockReturnValue(true);
});

describe("landing page", () => {
  it("keeps the old stage: masthead, film and one call to action", async () => {
    const html = await landingMarkup();

    expect(html).toContain(">bro.<");
    expect(html).toContain("Оферта");
    expect(html).toContain("Кабинет");
    expect(html).toContain("Сейф");
    expect(html).toContain('src="/brand/hero-portrait.mp4"');
    expect(html).toContain("Написать бро");
  });

  it("opens the iMessage thread without asking for a number", async () => {
    const html = await landingMarkup();

    // React escapes the `&` the `sms:` separator needs; a browser reads it
    // back as the link this helper built.
    expect(html).toContain(
      `href="${imessageLink(broLine).replace("&", "&amp;")}"`
    );
    expect(html).toContain(broLine);
    expect(html).toContain("Только синий iMessage; SMS не подойдёт.");
    expect(html).not.toContain('name="phone-number"');
    expect(html).not.toContain("<form");
  });

  it("says onboarding is closed when the deployment has no line", async () => {
    vi.stubEnv("IMESSAGE_PHONE_NUMBER", "");

    const html = await landingMarkup();

    expect(html).toContain("Пока закрыто");
    expect(html).not.toContain("sms:");
  });

  it("links this app's routes", async () => {
    const html = await landingMarkup();

    expect(html).toContain('href="/oferta"');
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain('href="/vault"');
    expect(html).not.toContain('href="/workspace"');
  });

  it("names the page once and anchors the tariffs the offer points at", async () => {
    const { env } = await import("@shared/environment");
    const html = await landingMarkup();

    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("bro — твой личный ИИ-агент</h1>");
    expect(html).toContain('id="pricing"');
    expect(html).toContain("Тарифы");
    expect(html).toContain(
      `Бесплатный режим — до ${String(env.FREE_MESSAGES_PER_DAY)} сообщений в день`
    );
    expect(html).toContain(
      `Полный доступ — ${String(env.PRICE_RUB)} ₽ за 30 календарных дней`
    );
  });

  it("describes the paid tariff without a price when YooKassa is off", async () => {
    mocks.yooKassaConfigured.mockReturnValue(false);
    const { env } = await import("@shared/environment");

    const html = await landingMarkup();

    expect(html).toContain(
      `Полный доступ — до ${String(env.PAID_MESSAGES_PER_DAY)} сообщений в день`
    );
    expect(html).toContain("Оплата пока не подключена.");
    expect(html).not.toContain("₽");
  });

  it("carries the old title and Open Graph card", async () => {
    const { metadata } = await import("@app/(public)/page");

    expect(metadata.title).toEqual({
      absolute: "bro — твой личный ИИ-агент",
    });
    expect(metadata.openGraph).toMatchObject({
      images: ["/brand/bro-og.png"],
      title: "bro — твой личный ИИ-агент",
    });
  });

  it("opens Messages with a greeting on the separator iOS accepts", () => {
    expect(imessageLink(broLine)).toBe(
      `sms:${broLine}&body=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82`
    );
  });
});

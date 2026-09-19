import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { yooKassaConfigured } from "@db/services/yookassa";
import { env } from "@shared/environment";
import { imessageLink } from "@app/(public)/_components/access-form";
import LandingPage, { metadata } from "@app/(public)/page";

const mocks = vi.hoisted(() => ({
  yooKassaConfigured: vi.fn<typeof yooKassaConfigured>(),
}));

vi.mock("@db/services/yookassa", () => ({
  yooKassaConfigured: mocks.yooKassaConfigured,
}));

const landingMarkup = () =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(LandingPage)
    )
  );

beforeEach(() => {
  mocks.yooKassaConfigured.mockReturnValue(true);
});

describe("landing page", () => {
  it("keeps the old stage: masthead, film and one call to action", () => {
    const html = landingMarkup();

    expect(html).toContain(">bro.<");
    expect(html).toContain("Оферта");
    expect(html).toContain("Кабинет");
    expect(html).toContain("Сейф");
    expect(html).toContain('src="/brand/hero-portrait.mp4"');
    expect(html).toContain("Получить своего бро");
  });

  it("asks for a phone number and explains the iMessage requirement", () => {
    const html = landingMarkup();

    expect(html).toContain('name="phone-number"');
    expect(html).toContain("Только синий iMessage; SMS не подойдёт.");
  });

  it("links this app's routes without advertising a line", () => {
    const html = landingMarkup();

    expect(html).toContain('href="/oferta"');
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain('href="/vault"');
    expect(html).not.toContain('href="/workspace"');
    expect(html).not.toContain("sms:");
    expect(html).not.toContain("+16282649335");
  });

  it("names the page once and anchors the tariffs the offer points at", () => {
    const html = landingMarkup();

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

  it("describes the paid tariff without a price when YooKassa is off", () => {
    mocks.yooKassaConfigured.mockReturnValue(false);

    const html = landingMarkup();

    expect(html).toContain(
      `Полный доступ — до ${String(env.PAID_MESSAGES_PER_DAY)} сообщений в день`
    );
    expect(html).toContain("Оплата пока не подключена.");
    expect(html).not.toContain("₽");
  });

  it("carries the old title and Open Graph card", () => {
    expect(metadata.title).toEqual({
      absolute: "bro — твой личный ИИ-агент",
    });
    expect(metadata.openGraph).toMatchObject({
      images: ["/brand/bro-og.png"],
      title: "bro — твой личный ИИ-агент",
    });
  });

  it("opens Messages with a greeting on the separator iOS accepts", () => {
    expect(imessageLink("+16282649335")).toBe(
      "sms:+16282649335&body=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82"
    );
  });
});

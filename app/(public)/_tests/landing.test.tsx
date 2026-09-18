import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { imessageLink } from "@app/(public)/_components/access-form";
import LandingPage from "@app/(public)/page";

const landingMarkup = () =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(LandingPage)
    )
  );

describe("landing page", () => {
  it("asks for a phone number and explains the iMessage requirement", () => {
    const html = landingMarkup();

    expect(html).toContain("Получить своего Бро");
    expect(html).toContain("Только синий iMessage; SMS не подойдёт.");
    expect(html).toContain("Заказы и покупки");
    expect(html).toContain("Письма и календарь");
    expect(html).toContain("Напоминания");
    expect(html).toContain("Telegram");
  });

  it("links the workspace and the offer without advertising a line", () => {
    const html = landingMarkup();

    expect(html).toContain('href="/workspace"');
    expect(html).toContain('href="/oferta"');
    expect(html).not.toContain("sms:");
  });

  it("opens Messages with a greeting on the separator iOS accepts", () => {
    expect(imessageLink("+16282649335")).toBe(
      "sms:+16282649335&body=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82"
    );
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { imessageLink } from "@app/(public)/_components/write-bro";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "landing-body" }),
  Source_Serif_4: () => ({ variable: "landing-display" }),
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
});

describe("landing page", () => {
  it("shows the portrait wallpaper behind the landing without foreground media", async () => {
    const html = await landingMarkup();
    expect(html).toContain(">bro.<");
    expect(html).toContain("Оферта");
    expect(html).toContain("Кабинет");
    expect(html).toContain("Сейф");
    expect(html).toContain('data-portrait-wallpaper=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/href="\/brand\/portraits\//g)).toHaveLength(12);
    expect(html).not.toContain("<video");
    expect(html).not.toContain("hero-portrait.mp4");
    expect(html).not.toContain("film-edge");
    expect(html).toContain("Написать бро");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("bro — твой личный ИИ-агент</h1>");
  });
  it("keeps only the hero without lower sections, a footer or scroll cues", async () => {
    const html = await landingMarkup();
    const { document } = parseHTML(html);

    expect(html.match(/<main/g)).toHaveLength(1);
    expect(html.match(/<section/g)).toHaveLength(1);
    expect(html).not.toContain("<h2");
    expect(html).not.toContain("<footer");
    expect(document.querySelectorAll('a[href^="#"]')).toHaveLength(0);
    expect(html).not.toContain('data-slot="dialog-trigger"');
    expect(html).not.toContain('data-slot="collapsible-trigger"');
  });
  it("opens the iMessage thread without asking for a number", async () => {
    const html = await landingMarkup();
    expect(html).toContain(
      `href="${imessageLink(broLine).replace("&", "&amp;")}"`
    );
    expect(html).toContain('aria-label="Написать бро в iMessage"');
    expect(html.match(/aria-label="Написать бро в iMessage"/g)).toHaveLength(1);
    expect(html).not.toContain('name="phone-number"');
    expect(html).not.toContain("<form");
  });
  it("says onboarding is closed when the deployment has no line", async () => {
    vi.stubEnv("IMESSAGE_PHONE_NUMBER", "");
    const html = await landingMarkup();
    expect(html).toContain("Пока закрыто");
    expect(html).toContain('disabled=""');
    expect(
      parseHTML(html).document.querySelectorAll("button[disabled]")
    ).toHaveLength(1);
    expect(html).not.toContain("sms:");
  });
  it("links this app's routes", async () => {
    const html = await landingMarkup();
    expect(html).toContain('href="/oferta"');
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain('href="/vault"');
    expect(html).not.toContain('href="/workspace"');
  });
  it("opens Messages with a greeting on the separator iOS accepts", () => {
    expect(imessageLink(broLine)).toBe(
      `sms:${broLine}&body=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82`
    );
  });
});

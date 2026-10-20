import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "landing-body" }),
  Source_Serif_4: () => ({ variable: "landing-display" }),
}));

// The page reads Photon's project from the validated environment at import,
// so each render starts from a fresh module graph with the project this test
// wants.
const landingMarkup = async () => {
  const { default: LandingPage } = await import("@app/(public)/page");
  return renderToStaticMarkup(createElement(LandingPage));
};

// `vi.unstubAllEnvs` would take the shared test environment down with it, so
// each test restates the project it wants instead of clearing every stub.
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("IMESSAGE_PROJECT_ID", "project-1");
  vi.stubEnv("IMESSAGE_PROJECT_SECRET", "secret-1");
});

describe("landing page", () => {
  it("shows the portrait wallpaper behind the landing without foreground media", async () => {
    const html = await landingMarkup();
    expect(html).toContain(">bro.<");
    expect(html).toContain("Оферта");
    expect(html).toContain("Кабинет");
    expect(html).not.toContain("Сейф");
    expect(html).toContain('data-portrait-wallpaper=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/href="\/brand\/portraits\//g)).toHaveLength(12);
    expect(html).not.toContain("<video");
    expect(html).not.toContain("hero-portrait.mp4");
    expect(html).not.toContain("film-edge");
    expect(html).toContain("Написать bro");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("bro — твой последний ИИ-агент</h1>");
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
    expect(
      document.querySelectorAll("section button, section [role=button]")
    ).toHaveLength(1);
    expect(document.querySelectorAll("section p")).toHaveLength(0);
  });
  it("starts a visitor at sign-in, where their phone gets a line", async () => {
    // Photon's line answers only registered phones: a straight `sms:` link
    // reached «This number didn't recognize yours».
    const { document } = parseHTML(await landingMarkup());
    const write = document.querySelector('a[aria-label="Написать бро"]');
    expect(write?.getAttribute("href")).toBe("/sign-in");
    expect(write?.textContent).toBe("Написать bro");
    expect(document.querySelectorAll('a[href^="sms:"]')).toHaveLength(0);
  });
  it("says onboarding is closed when the deployment has no Photon project", async () => {
    vi.stubEnv("IMESSAGE_PROJECT_ID", "");
    const html = await landingMarkup();
    expect(html).toContain("Пока закрыто");
    expect(
      parseHTML(html).document.querySelectorAll("button[disabled]")
    ).toHaveLength(1);
    expect(
      parseHTML(html).document.querySelector("button[disabled]")?.textContent
    ).toBe("Написать bro");
  });
  it("links this app's routes", async () => {
    const html = await landingMarkup();
    expect(html).toContain('href="/oferta"');
    expect(html).toContain('href="/sign-in"');
    expect(html).not.toContain('href="/vault"');
    expect(html).not.toContain('href="/workspace"');
  });
});

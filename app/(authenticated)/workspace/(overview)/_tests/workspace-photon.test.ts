import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ChannelsSection,
  LimitsSection,
} from "@app/(authenticated)/workspace/(overview)/page";

const dayMs = 24 * 60 * 60 * 1000;

// The dialog portals into the document, which a static render has not got:
// its parts render in place here.
const part = vi.hoisted(
  () =>
    ({ children }: { readonly children?: ReactNode }) =>
      children
);
vi.mock("@web/components/ui/dialog", () => ({
  Dialog: part,
  DialogClose: part,
  DialogContent: part,
  DialogDescription: part,
  DialogTitle: ({ children }: { readonly children?: ReactNode }) =>
    createElement("h2", null, children),
}));

describe("workspace Photon channel", () => {
  it("disables iMessage without advertising another deployment's number", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        imessageConfigured: false,
        imessagePhoneNumber: undefined,
      })
    );

    expect(html).toContain("Подключи Photon, чтобы включить iMessage.");
    expect(html).not.toContain("+12052611117");
    expect(html).not.toContain("sms:");
  });

  it("links the configured deployment number", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        imessageConfigured: true,
        imessagePhoneNumber: "+12025550123",
      })
    );

    expect(html).toContain("sms:+12025550123");
    expect(html).toContain("iMessage откроет +12025550123.");
  });

  it("makes writing to Bro the primary action and the web chat secondary", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        imessageConfigured: true,
        imessagePhoneNumber: "+12025550123",
      })
    );

    const write = html.indexOf("Написать Bro</a>");
    const web = html.indexOf("Открыть чат в вебе</a>");
    expect(write).toBeGreaterThan(-1);
    expect(web).toBeGreaterThan(write);
    expect(html).toMatch(/href="sms:[^"]*"[^>]*data-variant="paper"/u);
    expect(html).not.toContain("Напиши Bro</h2>");
  });

  it("covers the cabinet of an account that has not written to Bro yet", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        imessageConfigured: true,
        imessagePhoneNumber: "+12025550123",
        welcome: true,
      })
    );

    expect(html).toContain("Напиши Bro</h2>");
    expect(html).toContain("Позже");
    // The dialog offers iMessage alone; the web chat stays in the cabinet.
    expect(html.split("Открыть чат в вебе")).toHaveLength(2);
    expect(html).toContain("sms:+12025550123");
  });

  it("does not greet with a line it cannot open", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        imessageConfigured: true,
        imessagePhoneNumber: undefined,
        welcome: true,
      })
    );

    expect(html).not.toContain("Напиши Bro</h2>");
  });

  it("reports a connected Photon line without requiring its number", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        imessageConfigured: true,
        imessagePhoneNumber: undefined,
      })
    );

    expect(html).toContain("Photon подключён");
    expect(html).not.toContain("sms:");
  });
});

describe("workspace limits", () => {
  it("counts the paid month from zero when it was bought ahead of time", () => {
    const html = renderToStaticMarkup(
      createElement(LimitsSection, {
        paid: true,
        paidUntil: new Date(Date.now() + 45 * dayMs),
      })
    );

    expect(html).toContain("прошло 0 из 30 дней");
    expect(html).toContain("width:0%");
  });

  it("never counts past the month", () => {
    const html = renderToStaticMarkup(
      createElement(LimitsSection, {
        paid: true,
        paidUntil: new Date(Date.now() + 2 * dayMs),
      })
    );

    expect(html).toContain("прошло 28 из 30 дней");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChannelsSection,
  LimitsSection,
} from "@app/(authenticated)/workspace/page";

const dayMs = 24 * 60 * 60 * 1000;

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

  it("does not advertise a phone-number override without its connector", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        imessageConfigured: false,
        imessagePhoneNumber: "+12025550123",
      })
    );

    expect(html).toContain("Подключи Photon, чтобы включить iMessage.");
    expect(html).not.toContain("sms:");
  });

  it("keeps the web chat as a text action", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        imessageConfigured: false,
        imessagePhoneNumber: undefined,
      })
    );

    expect(html).toContain('href="/chat"');
    expect(html).toContain("Открыть чат");
    expect(html).toContain("Написать Bro");
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

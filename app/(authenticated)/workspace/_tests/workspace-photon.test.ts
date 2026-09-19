import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelsSection } from "@app/(authenticated)/workspace/page";

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

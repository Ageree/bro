import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelsSection } from "@app/(authenticated)/(workspace)/page";

describe("workspace Photon channel", () => {
  it("disables iMessage without advertising another deployment's number", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        browserReady: true,
        imessageConfigured: false,
        imessagePhoneNumber: undefined,
      })
    );

    expect(html).toContain("Set up Photon to enable iMessage.");
    expect(html).not.toContain("+12052611117");
    expect(html).not.toContain("sms:");
  });

  it("links the configured deployment number", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        browserReady: true,
        imessageConfigured: true,
        imessagePhoneNumber: "+12025550123",
      })
    );

    expect(html).toContain("sms:+12025550123");
    expect(html).toContain("iMessage opens +12025550123.");
  });

  it("reports a connected Photon line without requiring its number", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        browserReady: true,
        imessageConfigured: true,
        imessagePhoneNumber: undefined,
      })
    );

    expect(html).toContain("Photon is connected.");
    expect(html).not.toContain("sms:");
  });

  it("does not advertise a phone-number override without its connector", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelsSection, {
        browserReady: true,
        imessageConfigured: false,
        imessagePhoneNumber: "+12025550123",
      })
    );

    expect(html).toContain("Set up Photon to enable iMessage.");
    expect(html).not.toContain("sms:");
  });
});

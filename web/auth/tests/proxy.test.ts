import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthSession } from "@db/services/auth/session";
import { config, proxy } from "../../../proxy";

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn<typeof getAuthSession>(),
}));

vi.mock("@db/services/auth/session", () => ({
  getAuthSession: mocks.getAuthSession,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthSession.mockResolvedValue(null);
});

describe("auth proxy matcher", () => {
  it("does not match the public fonts and brand assets the landing shows", () => {
    for (const url of [
      "/fonts/vault-variable.woff2",
      "/brand/hero-portrait.mp4",
      "/brand/bro-og.png",
      "/icon.svg?icon.3ji5cuvunvd-i.svg",
      "/apple-icon.png?apple-icon.1vp36n672fqmo.png",
    ]) {
      expect(
        unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })
      ).toBe(false);
    }
  });

  it("continues to match protected application routes", () => {
    expect(
      unstable_doesMiddlewareMatch({
        config,
        nextConfig: {},
        url: "/vault",
      })
    ).toBe(true);
  });

  it("serves the public landing, its offer and its privacy policy without a session", async () => {
    const responses = await Promise.all(
      [
        "https://example.com/",
        "https://example.com/oferta",
        "https://example.com/privacy",
      ].map(async (url) => await proxy(new NextRequest(url)))
    );

    for (const response of responses) {
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it("serves the YooKassa webhook without a session but not the checkout", async () => {
    const webhook = await proxy(
      new NextRequest("https://example.com/api/yookassa", { method: "POST" })
    );
    expect(webhook.headers.get("x-middleware-next")).toBe("1");

    const checkout = await proxy(
      new NextRequest("https://example.com/api/pay")
    );
    expect(checkout.headers.get("location")).toBe(
      "https://example.com/sign-in?callbackUrl=%2Fapi%2Fpay"
    );
  });

  it("still sends the workspace through sign-in", async () => {
    const response = await proxy(
      new NextRequest("https://example.com/workspace")
    );

    expect(response.headers.get("location")).toBe(
      "https://example.com/sign-in?callbackUrl=%2Fworkspace"
    );
  });

  it("exempts only the two self-authenticating phone webhooks, not a phone prefix", async () => {
    const responses = await Promise.all(
      ["initiation", "post-call"].map(
        async (route) =>
          await proxy(
            new NextRequest(`https://example.com/api/phone/${route}`, {
              method: "POST",
            })
          )
      )
    );
    for (const response of responses)
      expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(getAuthSession).not.toHaveBeenCalled();
    const other = await proxy(
      new NextRequest("https://example.com/api/phone/status")
    );
    expect(other.status).toBe(307);
    expect(other.headers.get("location")).toContain("/sign-in");
  });

  it("leaves provider webhook verification to the Eve channel", async () => {
    const response = await proxy(
      new NextRequest("https://example.com/eve/v1/browser-use", {
        method: "POST",
      })
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it("allows the schedule dispatcher without a browser session in development", async () => {
    const response = await proxy(
      new NextRequest("http://localhost:3000/eve/v1/dev/schedules/dynamic")
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(getAuthSession).not.toHaveBeenCalled();
  });
});

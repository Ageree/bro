import { afterEach, describe, expect, it, vi } from "vitest";
import type { fetchPublic } from "@agent/lib/sandbox/public-fetch";

const network = vi.hoisted(() => ({
  fetchPublic: vi.fn<typeof fetchPublic>(),
}));
vi.mock("@agent/lib/sandbox/public-fetch", () => ({
  fetchPublic: network.fetchPublic,
}));

import { pageKey, readPricePage } from "@agent/lib/subscriptions/page";

afterEach(() => {
  vi.clearAllMocks();
});

const product = `<script type="application/ld+json">${JSON.stringify({
  "@type": "Product",
  name: "Чайник",
  offers: { price: "7490", priceCurrency: "RUB" },
})}</script>`;

describe("reading a product page", () => {
  it("reads the price through the public-only fetch", async () => {
    network.fetchPublic.mockResolvedValue(
      new Response(product, { headers: { "content-type": "text/html" } })
    );
    expect(
      await readPricePage(new URL("https://shop.example/p/1"))
    ).toMatchObject({
      amount: 7_490,
      currency: "RUB",
      kind: "price",
      landedOn: "shop.example/p/1",
    });
    const [, init] = network.fetchPublic.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("user-agent")).toContain("Mozilla");
  });

  it("never follows a redirect into the network", async () => {
    network.fetchPublic.mockResolvedValue(
      new Response(null, {
        headers: { location: "https://169.254.169.254/latest/meta-data" },
        status: 302,
      })
    );
    expect(await readPricePage(new URL("https://shop.example/p/1"))).toEqual({
      kind: "unreachable",
      reason: "blocked-host",
    });
    expect(network.fetchPublic).toHaveBeenCalledTimes(1);
  });

  it("calls a refusal or a bot check what it is", async () => {
    network.fetchPublic.mockResolvedValue(new Response("no", { status: 403 }));
    expect(await readPricePage(new URL("https://shop.example/p/1"))).toEqual({
      kind: "blocked",
      reason: "http 403",
    });
    network.fetchPublic.mockResolvedValue(
      new Response("<title>Подтвердите, что вы человек</title>")
    );
    expect(await readPricePage(new URL("https://shop.example/p/1"))).toEqual({
      kind: "blocked",
      reason: "bot-check",
    });
  });

  it("names the page a redirect led to", async () => {
    network.fetchPublic
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { location: "https://shop.example/p/2" },
          status: 301,
        })
      )
      .mockResolvedValueOnce(new Response(product));
    expect(
      await readPricePage(new URL("https://shop.example/p/1"))
    ).toMatchObject({ landedOn: "shop.example/p/2" });
  });

  it("keys a page by its link without tracking parameters", () => {
    expect(
      pageKey(new URL("https://www.shop.example/item/?utm_source=x&id=2&a=1"))
    ).toBe("shop.example/item?a=1&id=2");
    expect(pageKey(new URL("https://shop.example/p/1/#reviews"))).toBe(
      "shop.example/p/1"
    );
    // A value that holds «&» or «=», or another port, is another page.
    expect(pageKey(new URL("https://shop.example/p?a=1%26b%3D2"))).not.toBe(
      pageKey(new URL("https://shop.example/p?a=1&b=2"))
    );
    expect(pageKey(new URL("https://shop.example:8443/p/1"))).toBe(
      "shop.example:8443/p/1"
    );
  });
});

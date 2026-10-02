import { afterEach, describe, expect, it, vi } from "vitest";
import type { fetchPublic } from "@agent/lib/sandbox/public-fetch";

const network = vi.hoisted(() => ({
  fetchPublic: vi.fn<typeof fetchPublic>(),
}));
vi.mock("@agent/lib/sandbox/public-fetch", () => ({
  fetchPublic: network.fetchPublic,
}));

import { readPricePage } from "@agent/lib/subscriptions/page";

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
    ).toMatchObject({ amount: 7_490, currency: "RUB", kind: "price" });
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
});

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.stubEnv("PRICE_RUB", "");
  vi.stubEnv("PRICE_CARD_RUB", "");
  vi.resetModules();
});

async function loadCardPrice(environment: Record<string, string> = {}) {
  vi.resetModules();
  // Whatever the session sets, a case sees only its own prices.
  vi.stubEnv("PRICE_RUB", undefined);
  vi.stubEnv("PRICE_CARD_RUB", undefined);
  for (const [name, value] of Object.entries(environment)) {
    vi.stubEnv(name, value);
  }
  return (await import("@shared/billing/price")).cardPriceRub;
}

describe("card price", () => {
  it("grosses the base price up for the card share, rounded up to tens", async () => {
    // 2000 / 0.965 = 2072.5 -> 2080.
    expect((await loadCardPrice({ PRICE_RUB: "2000" }))()).toBe(2080);
    // 1000 / 0.965 = 1036.3 -> 1040.
    expect((await loadCardPrice({ PRICE_RUB: "1000" }))()).toBe(1040);
  });

  it("uses PRICE_CARD_RUB when it is set", async () => {
    const cardPriceRub = await loadCardPrice({
      PRICE_CARD_RUB: "2150",
      PRICE_RUB: "2000",
    });
    expect(cardPriceRub()).toBe(2150);
  });
});

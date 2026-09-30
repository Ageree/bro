import { afterEach, describe, expect, it, vi } from "vitest";

const settings = ["BROWSER_VM_PROXY_RUB_PER_GB", "USAGE_USD_RUB"];

afterEach(() => {
  for (const name of settings) vi.stubEnv(name, "");
  vi.resetModules();
});

async function loadPrices(environment: Record<string, string> = {}) {
  vi.resetModules();
  for (const [name, value] of Object.entries(environment)) {
    vi.stubEnv(name, value);
  }
  return import("@shared/costs/prices");
}

describe("cost prices", () => {
  it("converts dollars at the configured rate, 84.41 by default", async () => {
    expect((await loadPrices()).usdToRub(1)).toBe(84.41);
    expect((await loadPrices({ USAGE_USD_RUB: "90" })).usdToRub(0.5)).toBe(45);
  });

  it("prices a VM hour by its flavor, and knows no unknown flavor", async () => {
    const prices = await loadPrices();
    expect(prices.vmUptimeRub("gen-2-4", 3600)).toBe(2.97);
    expect(prices.vmUptimeRub("gen-2-4", 600)).toBe(0.495);
    expect(prices.vmUptimeRub("gen-9-99", 3600)).toBeUndefined();
  });

  it("prices proxy traffic by the gigabyte", async () => {
    expect((await loadPrices()).proxyTrafficRub(1e9)).toBe(23);
    expect(
      (await loadPrices({ BROWSER_VM_PROXY_RUB_PER_GB: "30" })).proxyTrafficRub(
        5e8
      )
    ).toBe(15);
  });

  it("prices RouterAI tokens, cached input apart, and no unknown model", async () => {
    const prices = await loadPrices();
    expect(
      prices.routerAiTokensRub("deepseek/deepseek-v4.1-flash", {
        cachedInputTokens: 1_000_000,
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
      })
    ).toBe(59.15);
    expect(
      prices.routerAiTokensRub("openai/gpt-5.6-luna", {
        cachedInputTokens: 0,
        inputTokens: 1,
        outputTokens: 1,
      })
    ).toBeUndefined();
  });
});

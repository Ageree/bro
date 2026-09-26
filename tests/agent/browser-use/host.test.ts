import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() =>
  vi.fn<(host: string) => Promise<{ address: string; family: number }>>()
);
vi.mock("node:dns/promises", () => ({ lookup }));

function dnsError(code: string) {
  return Object.assign(new Error(`getaddrinfo ${code} barber.example`), {
    code,
  });
}

beforeEach(() => {
  lookup.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("whether a site's name exists", () => {
  it("reads the host of an origin or of a bare domain", async () => {
    const { siteHostname } = await import("@agent/lib/browser-use/host");

    expect(siteHostname("https://www.vkusvill.ru/cart")).toBe(
      "www.vkusvill.ru"
    );
    expect(siteHostname("barbershop-arthur.ru")).toBe("barbershop-arthur.ru");
    expect(siteHostname("  ")).toBeUndefined();
  });

  it("calls a name the resolver says does not exist missing", async () => {
    lookup.mockRejectedValue(dnsError("ENOTFOUND"));
    const { siteHostMissing } = await import("@agent/lib/browser-use/host");

    await expect(
      siteHostMissing("https://barbershop-arthur-profsoyuznaya.ru")
    ).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(
      "barbershop-arthur-profsoyuznaya.ru"
    );
  });

  it("holds nothing up on a name that resolves", async () => {
    lookup.mockResolvedValue({ address: "93.184.215.14", family: 4 });
    const { siteHostMissing } = await import("@agent/lib/browser-use/host");

    await expect(siteHostMissing("https://vkusvill.ru")).resolves.toBe(false);
  });

  it("holds nothing up when the resolver itself fails", async () => {
    lookup.mockRejectedValue(dnsError("EAI_AGAIN"));
    const { siteHostMissing } = await import("@agent/lib/browser-use/host");

    await expect(siteHostMissing("https://vkusvill.ru")).resolves.toBe(false);
  });

  it("holds nothing up when the resolver does not answer in time", async () => {
    vi.useFakeTimers();
    lookup.mockReturnValue(new Promise(() => undefined));
    const { siteHostMissing } = await import("@agent/lib/browser-use/host");

    const missing = siteHostMissing("https://vkusvill.ru");
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(missing).resolves.toBe(false);
  });
});

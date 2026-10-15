import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The address of a shared point (`reverseGeocode`): Russian address parts,
 * never a place's own name; one request per point rounded to about 11 m;
 * nothing at sea; and `wait: false` never waits for the request slot.
 */

const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: new Date("2026-10-15T10:00:00.000Z") });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function answer(body: typeof tverskaya | { readonly error: string }) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

const tverskaya = {
  address: {
    city: "Москва",
    country: "Россия",
    house_number: "7",
    postcode: "125009",
    road: "Тверская улица",
  },
  display_name: "Кафе Пушкин, 7, Тверская улица, Москва, 125009, Россия",
  name: "Кафе Пушкин",
};

describe("the address of a shared point", () => {
  it("reads the address parts in Russian and asks once per point", async () => {
    fetchMock.mockResolvedValue(answer(tverskaya));
    const { reverseGeocode } = await import("@agent/lib/routes/openstreetmap");
    const signal = new AbortController().signal;
    expect(await reverseGeocode(55.761_23, 37.609_87, signal)).toBe(
      "Тверская улица 7, Москва"
    );
    // About 5 m away: the same rounded point, no second request.
    expect(await reverseGeocode(55.761_25, 37.609_88, signal)).toBe(
      "Тверская улица 7, Москва"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/reverse");
    expect(url.searchParams.get("accept-language")).toBe("ru");
    expect(url.searchParams.get("layer")).toBe("address");
  });

  it("gives nothing at sea", async () => {
    fetchMock.mockResolvedValue(answer({ error: "Unable to geocode" }));
    const { reverseGeocode } = await import("@agent/lib/routes/openstreetmap");
    expect(
      await reverseGeocode(43.0, 34.0, new AbortController().signal)
    ).toBeUndefined();
  });

  it("does not wait for a busy slot when told not to", async () => {
    fetchMock.mockResolvedValue(answer(tverskaya));
    const { reverseGeocode } = await import("@agent/lib/routes/openstreetmap");
    const signal = new AbortController().signal;
    await reverseGeocode(55.7, 37.6, signal);
    expect(
      await reverseGeocode(55.8, 37.7, signal, { wait: false })
    ).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

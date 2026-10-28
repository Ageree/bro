import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The bank's XML comes in windows-1251: Cyrillic letters are single bytes from 0xC0. */
function windows1251(text: string) {
  return Uint8Array.from(Array.from(text), (letter) => {
    const code = letter.codePointAt(0) ?? 0;
    if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
    if (code === 0x401) return 0xa8;
    if (code === 0x451) return 0xb8;
    return code;
  });
}

function rateSet(date: string, usd: string) {
  return `<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="${date}" name="Foreign Currency Market"><Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>${usd}</Value></Valute><Valute ID="R01820"><NumCode>392</NumCode><CharCode>JPY</CharCode><Nominal>100</Nominal><Name>Японских иен</Name><Value>52,1204</Value></Valute></ValCurs>`;
}

const fetchMock = vi.fn<(url: URL) => Promise<Response>>();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The bank answers each date with the set it has for it. */
function bankHas(sets: Readonly<Record<string, string>>, latest: string) {
  fetchMock.mockImplementation(async (url) => {
    const asked = url.searchParams.get("date_req")?.replaceAll("/", ".") ?? "";
    return await Promise.resolve(
      new Response(windows1251(sets[asked] ?? latest))
    );
  });
}

describe("the bank's official rates", () => {
  const now = new Date("2026-10-28T09:00:00Z");

  it("names today's rate in rubles and kopecks, and tomorrow's once it is set", async () => {
    const { officialRateLines } = await import("@agent/lib/rates/cbr");
    bankHas(
      {
        "28.10.2026": rateSet("28.10.2026", "80,5307"),
        "29.10.2026": rateSet("29.10.2026", "81,0999"),
      },
      rateSet("29.10.2026", "81,0999")
    );

    expect(
      (await officialRateLines(["usd", "JPY"], now, AbortSignal.timeout(1000)))
        .lines
    ).toBe(
      [
        "Курс ЦБ РФ на 28.10.2026:",
        "USD — Доллар США: 80 руб. 53 коп.",
        "JPY — 100 Японских иен: 52 руб. 12 коп.",
        "Курс ЦБ РФ на завтра, 29.10.2026:",
        "USD — Доллар США: 81 руб. 10 коп.",
        "JPY — 100 Японских иен: 52 руб. 12 коп.",
      ].join("\n")
    );
  });

  it("tells no tomorrow the bank has not set, and names what it does not quote", async () => {
    const { officialRateLines } = await import("@agent/lib/rates/cbr");
    // Asked for the 29th before it is set, the bank answers with the 28th's.
    bankHas({}, rateSet("28.10.2026", "80,5307"));

    const read = await officialRateLines(
      ["USD", "BTC"],
      now,
      AbortSignal.timeout(1000)
    );
    expect(read.quoted).toBe(1);
    expect(read.lines).toBe(
      [
        "Курс ЦБ РФ на 28.10.2026:",
        "USD — Доллар США: 80 руб. 53 коп.",
        "ЦБ не устанавливает курс для: BTC.",
      ].join("\n")
    );
  });
});

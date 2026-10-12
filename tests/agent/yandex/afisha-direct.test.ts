import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afishaSearchDirect } from "@agent/lib/yandex/afisha/direct";
import { afishaSearchOperation } from "@agent/lib/yandex/afisha/search";
import { dataOf, fixture, runInPage } from "./page";

const args = afishaSearchOperation.args.parse({ query: "джаз" });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("afisha.search without a browser", () => {
  it("answers the same events as the page does for the same reply", async () => {
    const body = await fixture("afisha/search.json");
    const fetchSpy = vi.fn<typeof fetch>(async () => Response.json(body));
    vi.stubGlobal("fetch", fetchSpy);
    const direct = await afishaSearchDirect(args);
    const page = await runInPage(afishaSearchOperation.run, args, {
      origin: "https://afisha.yandex.ru/robots.txt",
      respond: () => ({ body }),
    });
    expect(direct).toEqual(dataOf(page));
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining(
        "https://afisha.yandex.ru/api/graphql?city=moscow"
      )
    );
    // A public request: no cookie goes with it.
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("cookie");
  });

  it("gives way to the browser on a refusal and leaves the server alone for ten minutes", async () => {
    const fetchSpy = vi.fn<typeof fetch>(
      async () => new Response("<html>captcha</html>", { status: 429 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    expect(await afishaSearchDirect(args)).toBeUndefined();
    expect(await afishaSearchDirect(args)).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11 * 60_000);
    fetchSpy.mockResolvedValue(
      Response.json(await fixture("afisha/search.json"))
    );
    expect(await afishaSearchDirect(args)).toBeDefined();
  });
});

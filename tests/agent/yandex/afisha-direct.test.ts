import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
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

  it("lists a kind of event for days as the page does, asking the same question", async () => {
    const body = await fixture("afisha/listing.json");
    const fetchSpy = vi.fn<typeof fetch>(async () => Response.json(body));
    vi.stubGlobal("fetch", fetchSpy);
    const bothAsk = async (
      input: z.input<typeof afishaSearchOperation.args>
    ) => {
      const listing = afishaSearchOperation.args.parse(input);
      const pageBodies: (string | null | undefined)[] = [];
      const page = await runInPage(afishaSearchOperation.run, listing, {
        origin: "https://afisha.yandex.ru/robots.txt",
        respond: (_, init) => {
          pageBodies.push(init.body);
          return { body };
        },
      });
      fetchSpy.mockClear();
      const direct = await afishaSearchDirect(listing);
      return {
        asked: z
          .json()
          .parse(
            JSON.parse(z.string().parse(fetchSpy.mock.calls[0]?.[1]?.body))
          ),
        direct,
        page: dataOf(page),
        pageAsked: z.json().parse(JSON.parse(pageBodies[0] ?? "{}")),
        url: fetchSpy.mock.calls[0]?.[0],
      };
    };
    const week = await bothAsk({
      category: "concert",
      from: "2026-10-24",
      to: "2026-10-25",
    });
    const words = await bothAsk({ category: "theatre", query: "ревизор" });
    const popular = await bothAsk({});
    for (const both of [week, words, popular]) {
      expect(both.direct).toEqual(both.page);
      expect(both.asked).toEqual(both.pageAsked);
    }
    expect(week.url).toEqual(expect.stringContaining("query_name=BroListing"));
    expect(week.asked).toMatchObject({
      variables: { dates: { date: "2026-10-24", period: 2 } },
    });
  });

  it("answers days that are none as the page does, without asking Afisha", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    expect(
      await afishaSearchDirect(
        afishaSearchOperation.args.parse({
          category: "concert",
          from: "2026-02-30",
        })
      )
    ).toEqual({ error: "bad_dates" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("takes an event without a date preview text, as the page does", async () => {
    vi.setSystemTime(Date.now() + 60 * 60_000);
    const body = z
      .object({
        data: z.object({
          search: z.object({
            groups: z.array(
              z.object({
                documents: z.array(
                  z.object({ object: z.record(z.string(), z.json()) })
                ),
              })
            ),
          }),
        }),
      })
      .parse(await fixture("afisha/search.json"));
    const first = body.data.search.groups[0]?.documents[0];
    if (first) first.object.datePreview = { text: null };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => Response.json(body))
    );
    const direct = await afishaSearchDirect(args);
    const page = await runInPage(afishaSearchOperation.run, args, {
      origin: "https://afisha.yandex.ru/robots.txt",
      respond: () => ({ body }),
    });
    expect(direct).toBeDefined();
    expect(direct).toEqual(dataOf(page));
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

  it("keeps the direct way open when only this request was wrong", async () => {
    // An earlier test's pause is in the module's memory: be well past it.
    vi.setSystemTime(Date.now() + 60 * 60_000);
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      Response.json({ data: null, errors: [{ message: "unknown city" }] })
    );
    vi.stubGlobal("fetch", fetchSpy);
    expect(await afishaSearchDirect(args)).toBeUndefined();
    fetchSpy.mockResolvedValue(
      Response.json(await fixture("afisha/search.json"))
    );
    expect(await afishaSearchDirect(args)).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

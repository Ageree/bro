import { describe, expect, it } from "vitest";
import {
  cardPrice,
  inSiteOrder,
  sortedByPrice,
  withoutSitePage,
  withSiteInputs,
} from "@agent/lib/browser-vm/site-ops/inputs";
import { knownSiteOperations } from "@agent/lib/browser-vm/site-ops/known";
import { siteOperationSchema } from "@agent/lib/browser-vm/site-ops/operation";

function known(name: string) {
  const operation = knownSiteOperations.find((one) => one.name === name);
  if (operation === undefined) throw new Error(name);
  return operation;
}

const card = (price: number | string | null) => ({ more: {}, price });

describe("what a site applies itself beyond its results page", () => {
  it("writes the site's own sort pairs, price keys and page into the address", () => {
    const ask = {
      page: 0,
      priceMax: null,
      priceMin: null,
      sort: "site" as const,
    };
    const wb = withSiteInputs(
      known("www.wildberries.ru/catalog/%id%/search.aspx"),
      "https://www.wildberries.ru/catalog/0/search.aspx?search=чайник",
      { ...ask, priceMin: 1500, sort: "price_asc" }
    );
    const wbUrl = new URL(wb.address);
    expect(wbUrl.searchParams.get("sort")).toBe("priceup");
    // Kopecks, and a ceiling the range key needs.
    expect(wbUrl.searchParams.get("priceU")).toBe("150000;100000000");
    expect(wb.applied).toEqual({ page: false, price: true, sort: true });
    const labirint = new URL(
      withSiteInputs(
        known("www.labirint.ru/search/%query%/"),
        "https://www.labirint.ru/search/анна каренина/",
        { ...ask, priceMax: 999.5, sort: "price_desc" }
      ).address
    );
    expect(labirint.searchParams.get("order")).toBe("price");
    expect(labirint.searchParams.get("way")).toBe("back");
    expect(labirint.searchParams.get("price_max")).toBe("1000");
    expect(labirint.searchParams.has("price_min")).toBe(false);
    const petrovich = known("moscow.petrovich.ru/search/");
    const second = withSiteInputs(
      petrovich,
      "https://moscow.petrovich.ru/search/?q=дрель",
      { ...ask, page: 1 }
    );
    expect(new URL(second.address).searchParams.get("p")).toBe("2");
    expect(withoutSitePage(petrovich, second.address)).toBe(
      new URL("https://moscow.petrovich.ru/search/?q=дрель").href
    );
    // An order the site has no pairs for, and a site with no inputs: as it was.
    const hh = known("hh.ru/search/vacancy");
    expect(
      withSiteInputs(hh, "https://hh.ru/search/vacancy?text=x", {
        ...ask,
        sort: "price_asc",
      }).applied.sort
    ).toBe(false);
    const tutu = "https://www.tutu.ru/poezda/Moskva/Kazan/?date=06.11.2026";
    expect(
      withSiteInputs(known("www.tutu.ru/poezda/%word%/%word%/"), tutu, {
        ...ask,
        sort: "price_asc",
      })
    ).toEqual({
      address: tutu,
      applied: { page: false, price: false, sort: false },
    });
  });

  it("keeps only the site's own keys and tokens", () => {
    const base = known("www.ozon.ru/search/");
    const refused = [
      "sorting=price;drop",
      "sorting=price asc",
      "sorting",
      "a=b=c",
      "12345=price",
    ].filter(
      (asc) =>
        siteOperationSchema.safeParse({ ...base, inputs: { sort: { asc } } })
          .success
    );
    expect(refused).toEqual([]);
    expect(
      siteOperationSchema.safeParse({
        ...base,
        inputs: { page: { first: 2, key: "page" } },
      }).success
    ).toBe(false);
  });

  it("reads a site's order back from its cards' prices", () => {
    expect(cardPrice("от 14 090 ₽")).toBe(14090);
    expect(cardPrice("314,50 ₽")).toBe(314.5);
    expect(cardPrice(null)).toBeNull();
    const rising = [103, 129, 129, 165, null, 176].map(card);
    expect(inSiteOrder(rising, "price_asc")).toBe(true);
    expect(inSiteOrder(rising, "price_desc")).toBe(false);
    // One card priced by the site's own card now and then still keeps it.
    expect(
      inSiteOrder([1281, 1290, 1250, 1345, 1350, 1376].map(card), "price_asc")
    ).toBe(true);
    expect(inSiteOrder([9390, 4990, 24900, 4720].map(card), "price_asc")).toBe(
      false
    );
    expect(inSiteOrder([1, 2, 3].map(card), "price_asc")).toBeUndefined();
    expect(
      sortedByPrice([500, null, 50, "300 ₽"].map(card), "price_asc").map(
        ({ price }) => price
      )
    ).toEqual([50, "300 ₽", 500, null]);
  });
});

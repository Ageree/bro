import { describe, expect, it } from "vitest";
import {
  amountsSaid,
  conditionMet,
  amountFromText,
  readPrice,
  sameProduct,
} from "@agent/lib/subscriptions/price";

function jsonLd(data: Parameters<typeof JSON.stringify>[0]) {
  return `<html><head><script type="application/ld+json">${JSON.stringify(data)}</script></head><body>Купить</body></html>`;
}

describe("reading a price", () => {
  it("parses amounts the way shops write them", () => {
    expect(amountFromText("7 490,00 ₽")).toBe(7_490);
    expect(amountFromText("7\u00a0490")).toBe(7_490);
    expect(amountFromText("7,490.50")).toBe(7_490.5);
    expect(amountFromText("7.490,50")).toBe(7_490.5);
    expect(amountFromText("1,500")).toBe(1_500);
    expect(amountFromText("12,5")).toBe(12.5);
    expect(amountFromText("199.99")).toBe(199.99);
    expect(amountFromText("0")).toBeUndefined();
    expect(amountFromText("по запросу")).toBeUndefined();
    // A range is not one price.
    expect(amountFromText("7 490 – 9 990 ₽")).toBeUndefined();
  });

  it("takes the product's offer from JSON-LD, its graph or its list", () => {
    const product = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Чайник Bork K780",
      offers: {
        "@type": "Offer",
        price: "7490.00",
        priceCurrency: "RUB",
      },
      sku: "K780",
    };
    expect(readPrice(jsonLd(product))).toEqual({
      amount: 7_490,
      currency: "RUB",
      extractor: "jsonld",
      kind: "price",
      name: "Чайник Bork K780",
      sku: "K780",
    });
    expect(
      readPrice(jsonLd({ "@graph": [{ "@type": "WebPage" }, product] }))
    ).toMatchObject({ amount: 7_490 });
    expect(
      readPrice(
        jsonLd([
          { "@type": "BreadcrumbList" },
          {
            ...product,
            offers: {
              "@type": "AggregateOffer",
              lowPrice: 6_990,
              priceCurrency: "RUR",
            },
          },
        ])
      )
    ).toMatchObject({ amount: 6_990, currency: "RUB" });
    // Sold out or used offers are not the product's price.
    expect(
      readPrice(
        jsonLd({
          ...product,
          offers: [
            { availability: "https://schema.org/InStock", price: "8 100" },
            { availability: "https://schema.org/OutOfStock", price: "5 000" },
            { itemCondition: "https://schema.org/UsedCondition", price: 4_000 },
          ],
        })
      )
    ).toMatchObject({ amount: 8_100 });
    // Sellers or variants at several prices give none.
    expect(
      readPrice(
        jsonLd({
          ...product,
          offers: [
            { price: "8 100", priceCurrency: "RUB" },
            { price: "7 900", priceCurrency: "RUB" },
          ],
        })
      )
    ).toEqual({ kind: "several-products" });
  });

  it("does not read the products a page recommends", () => {
    expect(
      readPrice(
        jsonLd({
          "@type": "Product",
          isRelatedTo: {
            "@type": "Product",
            name: "Фильтр",
            offers: { price: 300 },
          },
          name: "Чайник",
          offers: { price: 7_490, priceCurrency: "RUB" },
        })
      )
    ).toMatchObject({ amount: 7_490, name: "Чайник" });
  });

  it("refuses a catalogue of several products", () => {
    expect(
      readPrice(
        jsonLd([
          { "@type": "Product", name: "A", offers: { price: 100 } },
          { "@type": "Product", name: "B", offers: { price: 200 } },
        ])
      )
    ).toEqual({ kind: "several-products" });
  });

  it("falls back to the price meta tags and itemprop", () => {
    expect(
      readPrice(
        '<meta content="5 990" property="product:price:amount"><meta property="product:price:currency" content="RUB"><meta property="og:title" content="Наушники &amp; чехол">'
      )
    ).toEqual({
      amount: 5_990,
      currency: "RUB",
      extractor: "meta",
      kind: "price",
      name: "Наушники & чехол",
      sku: null,
    });
    expect(
      readPrice(
        '<meta property="og:title" content="Чайник"><span itemprop="price" content="1299.00">1 299 ₽</span><meta itemprop="priceCurrency" content="RUB">'
      )
    ).toMatchObject({
      amount: 1_299,
      currency: "RUB",
      extractor: "itemprop",
      name: "Чайник",
    });
    expect(
      readPrice(
        '<span itemprop="price" content="100"></span><span itemprop="price" content="200"></span>'
      )
    ).toEqual({ kind: "several-products" });
    expect(readPrice("<html><title>Just a moment...</title></html>")).toEqual({
      kind: "no-price",
    });
  });

  it("keeps a page's name and SKU short and plain", () => {
    const reading = readPrice(
      jsonLd({
        "@type": "Product",
        name: `<Чайник>\u0007 ${"x".repeat(300)}`,
        offers: { price: 1 },
        sku: 42,
      })
    );
    expect(reading).toMatchObject({ kind: "price", sku: "42" });
    const name = reading.kind === "price" ? reading.name : null;
    expect(name).toMatch(/^Чайник x+$/u);
    expect(name?.length).toBeLessThanOrEqual(120);
  });
});

describe("a watch's product and condition", () => {
  const source = {
    currency: "RUB",
    extractor: "jsonld" as const,
    landedOn: "shop.example/p/1",
    name: "Чайник",
    sku: "K780",
    url: "https://shop.example/p/1",
  };
  const reading = {
    amount: 7_000,
    currency: "RUB",
    extractor: "jsonld" as const,
    kind: "price" as const,
    name: "Чайник",
    sku: "K780",
  };

  it("counts a reading only of the same product", () => {
    expect(sameProduct(source, reading)).toBe(true);
    expect(sameProduct(source, { ...reading, sku: "K781" })).toBe(false);
    expect(sameProduct(source, { ...reading, currency: "USD" })).toBe(false);
    expect(sameProduct(source, { ...reading, extractor: "meta" })).toBe(false);
    expect(sameProduct(source, { ...reading, name: "Фильтр" })).toBe(false);
    expect(
      sameProduct({ ...source, sku: null }, { ...reading, sku: null })
    ).toBe(true);
  });

  it("is met below the amount, or on a drop from the first price", () => {
    expect(conditionMet({ amount: 8_000, kind: "below" }, 7_990, 9_000)).toBe(
      true
    );
    expect(conditionMet({ amount: 8_000, kind: "below" }, 8_000, 9_000)).toBe(
      false
    );
    expect(conditionMet({ kind: "drop", percent: 0 }, 8_999, 9_000)).toBe(true);
    expect(conditionMet({ kind: "drop", percent: 0 }, 9_000, 9_000)).toBe(
      false
    );
    expect(conditionMet({ kind: "drop", percent: 10 }, 8_200, 9_000)).toBe(
      false
    );
    expect(conditionMet({ kind: "drop", percent: 10 }, 8_100, 9_000)).toBe(
      true
    );
  });
});

describe("amounts in the person's words", () => {
  it("reads an amount with a rouble sign or word", () => {
    const said = amountsSaid(["меньше 8000р", "до 7500 руб.", "или 9тр"]);
    for (const amount of [8_000, 7_500, 9_000]) {
      expect(said.has(amount)).toBe(true);
    }
    expect(said.has(800)).toBe(false);
  });

  it("reads «8к», «8 000», «8,5 тыс» and percents", () => {
    const said = amountsSaid([
      "следи за ценой, напиши когда станет меньше 8к",
      "или ниже 7 500 ₽, или 8,5 тыс, или упадёт на 10%",
    ]);
    for (const amount of [8_000, 7_500, 8_500, 10]) {
      expect(said.has(amount)).toBe(true);
    }
    expect(said.has(9_000)).toBe(false);
  });

  it("does not take the digits of a link as an amount", () => {
    const said = amountsSaid(["https://shop.example/p/7000/ — меньше 5000"]);
    expect(said.has(5_000)).toBe(true);
    expect(said.has(7_000)).toBe(false);
  });
});

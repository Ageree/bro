import { describe, expect, it } from "vitest";
import { pageTitle } from "@agent/lib/subscriptions/page";
import {
  amountsSaid,
  conditionMet,
  amountFromText,
  daysSaid,
  readPrice,
  sameProduct,
} from "@agent/lib/subscriptions/price";

function jsonLd(data: Parameters<typeof JSON.stringify>[0]) {
  return `<html><head><script type="application/ld+json">${JSON.stringify(data)}</script></head><body>Купить</body></html>`;
}

/** The best of three reads of a page: a pause of the machine is no parser's time. */
function timed(html: string) {
  return Math.min(
    ...[0, 1, 2].map(() => {
      const started = performance.now();
      readPrice(html);
      pageTitle(html);
      return performance.now() - started;
    })
  );
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
    // A used offer is not the product's price; a sold-out one of the same
    // price leaves the one in stock.
    expect(
      readPrice(
        jsonLd({
          ...product,
          offers: [
            { availability: "https://schema.org/OutOfStock", price: "8 100" },
            { availability: "https://schema.org/InStock", price: "8 100" },
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

  it("gives no price for sizes at several prices, whichever is in stock", () => {
    const sizes = (small: string, medium: string) =>
      jsonLd({
        "@type": "Product",
        name: "Футболка",
        offers: [
          { availability: `https://schema.org/${small}`, price: 5_000 },
          { availability: `https://schema.org/${medium}`, price: 7_000 },
        ],
      });
    // Else «M in stock at 7 000», then «S back at 5 000» reads as a drop.
    expect(readPrice(sizes("OutOfStock", "InStock"))).toEqual({
      kind: "several-products",
    });
    expect(readPrice(sizes("InStock", "OutOfStock"))).toEqual({
      kind: "several-products",
    });
  });

  it("takes an aggregate offer's low price only when it is its one price", () => {
    const aggregate = (offers: Readonly<Record<string, number | string>>) =>
      readPrice(
        jsonLd({ "@type": "Product", name: "Чайник", offers, sku: "K780" })
      );
    expect(
      aggregate({ highPrice: 9_000, lowPrice: 5_000, offerCount: 12 })
    ).toEqual({ kind: "several-products" });
    expect(aggregate({ lowPrice: 5_000, offerCount: 12 })).toEqual({
      kind: "several-products",
    });
    expect(aggregate({ highPrice: 5_000, lowPrice: 5_000 })).toMatchObject({
      amount: 5_000,
    });
    expect(aggregate({ lowPrice: 5_000, offerCount: "1" })).toMatchObject({
      amount: 5_000,
    });
    // A price beside a range or a count of sellers is no one price either.
    expect(
      aggregate({ highPrice: 9_000, lowPrice: 5_000, price: 7_000 })
    ).toEqual({ kind: "several-products" });
    expect(aggregate({ offerCount: 12, price: 7_000 })).toEqual({
      kind: "several-products",
    });
  });

  it("reads a JSON-LD dot as schema.org's decimal point", () => {
    const priced = (price: string) =>
      readPrice(
        jsonLd({ "@type": "Product", name: "Чайник", offers: { price } })
      );
    expect(priced("990.000")).toMatchObject({ amount: 990 });
    expect(priced("7490.00")).toMatchObject({ amount: 7_490 });
    // A price a shop formatted is read as it writes it.
    expect(priced("7 490,00 ₽")).toMatchObject({ amount: 7_490 });
  });

  it("cuts links, domains and phone numbers out of a seller's name", () => {
    const reading = readPrice(
      jsonLd({
        "@type": "Product",
        name: "Чайник K780 1.7 л — пишите https://evil.example/x, shop-deals.ru или +7 (999) 123-45-67",
        offers: { price: 1 },
      })
    );
    const name = reading.kind === "price" ? reading.name : null;
    expect(name).toContain("Чайник K780 1.7 л");
    expect(name).not.toMatch(/evil|shop-deals|999|123/u);
    // Full-width dots and digits, handles and Telegram links too.
    const disguised = readPrice(
      jsonLd({
        "@type": "Product",
        name: "Чайник: пишите @kettle_seller, t.me/kettle_deals, shop．ru, ＋７ ９９９ １２３ ４５ ６７",
        offers: { price: 1 },
      })
    );
    const plain = disguised.kind === "price" ? disguised.name : null;
    expect(plain).toMatch(/^Чайник/u);
    expect(plain).not.toMatch(/kettle|shop|ru|999|９/u);
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

  it("calls a sold-out product unavailable, whatever other markup says", () => {
    expect(
      readPrice(
        `${jsonLd({
          "@type": "Product",
          name: "Чайник",
          offers: {
            availability: "https://schema.org/OutOfStock",
            price: 5_000,
          },
        })}<meta property="product:price:amount" content="5000">`
      )
    ).toEqual({ kind: "unavailable" });
  });

  it("reads every product before calling a page sold out", () => {
    const inStock = {
      "@type": "Product",
      name: "Чайник",
      offers: { availability: "https://schema.org/InStock", price: 7_490 },
      sku: "K780",
    };
    const soldOut = {
      ...inStock,
      offers: { availability: "https://schema.org/OutOfStock", price: 6_990 },
    };
    // The same product sold out in one node and in stock in another.
    expect(readPrice(jsonLd([soldOut, inStock]))).toMatchObject({
      amount: 7_490,
      kind: "price",
    });
    expect(readPrice(jsonLd([inStock, soldOut]))).toMatchObject({
      amount: 7_490,
    });
    // Another product sold out beside it: as ambiguous as a catalogue.
    expect(
      readPrice(jsonLd([{ ...soldOut, name: "Фильтр", sku: "F1" }, inStock]))
    ).toEqual({ kind: "several-products" });
    expect(readPrice(jsonLd([soldOut, { ...soldOut, sku: "K781" }]))).toEqual({
      kind: "unavailable",
    });
  });

  it("tells products of one name and price apart by SKU", () => {
    expect(
      readPrice(
        jsonLd([
          {
            "@type": "Product",
            name: "Чайник",
            offers: { price: 100 },
            sku: "A",
          },
          {
            "@type": "Product",
            name: "Чайник",
            offers: { price: 100 },
            sku: "B",
          },
        ])
      )
    ).toEqual({ kind: "several-products" });
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
    // Every price meta tag counts, not the first one.
    expect(
      readPrice(
        '<meta property="product:price:amount" content="5990"><meta property="og:price:amount" content="4990">'
      )
    ).toEqual({ kind: "several-products" });
    expect(readPrice("<html><title>Just a moment...</title></html>")).toEqual({
      kind: "no-price",
    });
  });

  it("reads a stranger's hostile page in time linear in its size", () => {
    // Each page at a size: a parser that backtracks or rescans is
    // quadratic, and eight times the page takes some 64 times as long.
    const pages = {
      "a long attribute": (size: number) => `<meta ${"a".repeat(size)}>`,
      "a meta never closed": (size: number) => "<meta ".repeat(size / 6),
      "a script never closed": (size: number) =>
        "<script type=".repeat(size / 13),
      "a title never closed": (size: number) => `<title${"x".repeat(size)}`,
      "an itemprop never closed": (size: number) =>
        `<span itemprop=${"=".repeat(size)}`,
      "many unclosed tags": (size: number) => "<a".repeat(size / 2),
      "many tags": (size: number) => "<a b=c>".repeat(size / 7),
      "quotes never closed": (size: number) => '<a "'.repeat(size / 4),
      // Every \`>\` stands inside a quote: a scan for the end outside quotes
      // would run to the end of the page from every tag.
      "every end inside a quote": (size: number) => '<">"'.repeat(size / 4),
      "a quote never closed before many ends": (size: number) =>
        `<meta content="${">".repeat(size)}`,
      "JSON-LD blocks of nothing": (size: number) =>
        '<script type="application/ld+json">{}</script>'.repeat(size / 47),
      "a JSON-LD list of nothing": (size: number) =>
        jsonLd(Array.from({ length: size / 3 }, () => ({}))),
      "a JSON-LD graph of nothing": (size: number) =>
        jsonLd({ "@graph": Array.from({ length: size / 3 }, () => ({})) }),
      "products in stock and sold out": (size: number) =>
        jsonLd(
          Array.from({ length: size / 60 }, (_, index) => ({
            "@type": "Product",
            offers:
              index % 2 === 0
                ? { price: 1 }
                : { availability: "OutOfStock", price: 1 },
          }))
        ),
      "empty meta tags": (size: number) => "<meta >".repeat(size / 7),
      "meta tags": (size: number) => "<META A=B>".repeat(size / 10),
      "unclosed quotes": (size: number) =>
        `<meta content="${"x ".repeat(size / 2)}>`,
    };
    const small = 256 * 1024;
    const slow = Object.entries(pages).flatMap(([kind, page]) => {
      const smallMs = timed(page(small));
      const largeMs = timed(page(small * 8));
      // Linear is about 8x; under 50 ms the ratio is only noise.
      const linear = largeMs < 50 || largeMs < 24 * Math.max(smallMs, 1);
      return largeMs < 2_000 && linear
        ? []
        : [
            `${kind}: ${String(Math.round(smallMs))} → ${String(Math.round(largeMs))} ms`,
          ];
    });
    expect(slow).toEqual([]);
  });

  it("reads no further than a product page has: a page past that is no one product", () => {
    const product = {
      "@type": "Product",
      name: "Чайник",
      offers: { price: 1 },
    };
    const graph = Array.from({ length: 700_000 }, () => ({}));
    // A spread of these into one call overflowed the stack.
    expect(readPrice(jsonLd({ "@graph": graph }))).toEqual({
      kind: "several-products",
    });
    expect(
      readPrice(
        `${jsonLd(product)}${'<script type="application/ld+json">{}</script>'.repeat(100)}`
      )
    ).toEqual({ kind: "several-products" });
    expect(
      readPrice(
        jsonLd({
          ...product,
          offers: Array.from({ length: 1_001 }, () => ({ price: 1 })),
        })
      )
    ).toEqual({ kind: "several-products" });
    expect(
      readPrice(
        `<meta property="product:price:amount" content="1">${"<meta>".repeat(2_000)}`
      )
    ).toEqual({ kind: "several-products" });
    // Up to the caps the page reads as before.
    expect(
      readPrice(
        `${jsonLd(product)}${"<meta>".repeat(1_000)}${'<script type="application/ld+json">{}</script>'.repeat(98)}`
      )
    ).toMatchObject({ amount: 1, kind: "price" });
  });

  it("does not end a tag at a > inside a quoted value", () => {
    expect(
      readPrice(
        '<meta property="product:price:amount" data-note="от 1 шт > опт" content="1990">'
      )
    ).toMatchObject({ amount: 1_990, extractor: "meta" });
  });

  it("finds the JSON-LD block and meta tags however their attributes are written", () => {
    expect(
      readPrice(
        `<SCRIPT TYPE='application/ld+json' nonce=x>${JSON.stringify({ "@type": "Product", name: "Чайник", offers: { price: 10 } })}</SCRIPT >`
      )
    ).toMatchObject({ amount: 10, extractor: "jsonld" });
    expect(
      readPrice(
        "<!-- <meta property=product:price:amount content=1> --><META Content=990 PROPERTY=product:price:amount>"
      )
    ).toMatchObject({ amount: 990, extractor: "meta" });
    expect(pageTitle("<html><title lang=ru>Just a moment...</title>")).toBe(
      "Just a moment..."
    );
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
    // A page title carries the price, so it pins no meta reading.
    const titled = {
      ...source,
      extractor: "meta" as const,
      name: "Чайник — купить по цене 8 990 ₽",
    };
    expect(
      sameProduct(titled, {
        ...reading,
        extractor: "meta",
        name: "Чайник — купить по цене 7 490 ₽",
      })
    ).toBe(true);
    expect(
      sameProduct({ ...source, sku: null }, { ...reading, sku: null })
    ).toBe(true);
  });

  it("is met below the amount, or on a drop from the first price", () => {
    expect(conditionMet({ amount: 8_000, kind: "below" }, 7_990, 9_000)).toBe(
      true
    );
    // «до 8000»: exactly 8 000 is met.
    expect(conditionMet({ amount: 8_000, kind: "below" }, 8_000, 9_000)).toBe(
      true
    );
    expect(conditionMet({ amount: 8_000, kind: "below" }, 8_001, 9_000)).toBe(
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
    const { amounts } = amountsSaid([
      "меньше 8000р",
      "до 7500 руб.",
      "или 9тр",
    ]);
    for (const amount of [8_000, 7_500, 9_000]) {
      expect(amounts.has(amount)).toBe(true);
    }
    expect(amounts.has(800)).toBe(false);
  });

  it("reads «8к», «8 000», «8,5 тыс», and percents apart from prices", () => {
    const { amounts, percents } = amountsSaid([
      "следи за ценой, напиши когда станет меньше 8к",
      "или ниже 7 500 ₽, или 8,5 тыс, или упадёт на 10%, или на 15 процентов",
    ]);
    for (const amount of [8_000, 7_500, 8_500]) {
      expect(amounts.has(amount)).toBe(true);
    }
    expect(amounts.has(9_000)).toBe(false);
    // «10%» is no price of 10.
    expect(amounts.has(10)).toBe(false);
    expect([...percents].toSorted((a, b) => a - b)).toEqual([10, 15]);
  });

  it("never takes the bare number of «8к» or «7,490»", () => {
    const { amounts } = amountsSaid(["меньше 8к", "или до 7,490", "или 12,5"]);
    expect([...amounts].toSorted((a, b) => a - b)).toEqual([
      12.5, 7_490, 8_000,
    ]);
  });

  it("reads a term in days, weeks or months", () => {
    expect(
      [
        ...daysSaid([
          "следи 2 недели",
          "или неделю, или на месяц, или 10 дней, или 3 месяца",
        ]),
      ].toSorted((a, b) => a - b)
    ).toEqual([7, 10, 14, 30, 90]);
    expect(daysSaid(["8000р, https://shop.example/30-days"]).size).toBe(0);
  });

  it("does not take the digits of a link as an amount", () => {
    const { amounts } = amountsSaid([
      "https://shop.example/p/7000/ — меньше 5000",
    ]);
    expect(amounts.has(5_000)).toBe(true);
    expect(amounts.has(7_000)).toBe(false);
  });
});

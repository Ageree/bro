import { describe, expect, it } from "vitest";
import { knownSiteOperations } from "@agent/lib/browser-vm/site-ops/known";
import {
  mergeSiteOperations,
  type SiteOperation,
  siteOperationOnSite,
  siteOperationSchema,
  siteOperationWorker,
  siteReadFit,
  widenedSiteOperation,
} from "@agent/lib/browser-vm/site-ops/operation";
import {
  errandSite,
  siteOperationsLine,
} from "@agent/lib/browser-vm/site-ops/run";

// What the worker found behind an ostrovok.ru run's three hotels on the stand
// (25.10, `SiteTraffic.operations`), as its record carries it.
const kazan: SiteOperation = {
  fields: {
    link: {
      parts: [["region_catalog_slug"], ["master_id"], ["ota_hotel_id"]],
      query: ["dates", "guests"],
      template: "/hotel/{0}/mid{1}/{2}/",
    },
    name: ["name"],
    price: ["price"],
  },
  items: ["map_hotels"],
  name: "ostrovok.ru/hotel/russia/kazan/",
  page: "https://ostrovok.ru/hotel/russia/kazan/?dates=%date%&guests=%number%&sort=%sort%",
  seen: { items: 2676, matched: 3, of: 3 },
  source: {
    kind: "xhr",
    method: "POST",
    url: "https://ostrovok.ru/hotel/search/v2/site/serp",
  },
};

describe("a site's operation as Bro keeps it", () => {
  it("takes what the worker finds and the reviewed ones", () => {
    expect(siteOperationSchema.parse(kazan)).toEqual(kazan);
    for (const operation of knownSiteOperations) {
      expect(siteOperationSchema.safeParse(operation).success).toBe(true);
    }
  });

  it("refuses a record with any value of the run, a header, a cookie or a body in it", () => {
    const records = [
      // A query value instead of its placeholder: the words the person searched.
      {
        ...kazan,
        page: "https://ostrovok.ru/hotel/russia/kazan/?dates=07.11.2026-09.11.2026",
      },
      // A phone, an id or an email in the path.
      {
        ...kazan,
        name: "ostrovok.ru/user/79217818876/",
        page: "https://ostrovok.ru/user/79217818876/",
      },
      {
        ...kazan,
        name: "ostrovok.ru/orders/ivan@mail.ru/",
        page: "https://ostrovok.ru/orders/ivan@mail.ru/",
      },
      // Keys the record never has: what a request or an answer carried.
      { ...kazan, cookies: "sid=abc" },
      {
        ...kazan,
        source: { ...kazan.source, headers: { authorization: "Bearer x" } },
      },
      { ...kazan, source: { ...kazan.source, body: '{"session_id":"x"}' } },
      // The request's own query (a session id), or another site's address.
      {
        ...kazan,
        source: {
          ...kazan.source,
          url: "https://ostrovok.ru/hotel/search/v2/site/serp?session=7082cb8b",
        },
      },
      {
        ...kazan,
        source: { ...kazan.source, url: "https://mc.yandex.ru/watch" },
      },
      // A link template with a value in it, and a name that is not the page's.
      {
        ...kazan,
        fields: {
          ...kazan.fields,
          link: { parts: [["id"]], query: [], template: "/hotel/7389083/{0}/" },
        },
      },
      { ...kazan, name: "ostrovok.ru/anything" },
      // A key of the data, or of the query, that is a value itself.
      { ...kazan, items: ["byId", "79217818"] },
      { ...kazan, items: ["c0ffee12", 0] },
      {
        ...kazan,
        fields: {
          ...kazan.fields,
          name: ["7082cb8b-d138-42b8-969c-26448d408401"],
        },
      },
      { ...kazan, fields: { ...kazan.fields, price: ["p".repeat(41)] } },
      {
        ...kazan,
        page: "https://ostrovok.ru/hotel/russia/kazan/?f12345=%flag%",
      },
      // A host beside the site's, not under it: another site's API.
      {
        ...kazan,
        source: {
          ...kazan.source,
          url: "https://api.notostrovok.ru/hotel/search/v2/site/serp",
        },
      },
    ];
    for (const record of records) {
      expect(siteOperationSchema.safeParse(record).success).toBe(false);
    }
    // A path part that is not a short latin word: a percent-encoded word, a
    // phone with dashes, a user name, a dotted name, a capital, a long one.
    for (const path of [
      "/city/%D0%BA%D0%B0%D0%B7%D0%B0%D0%BD%D1%8C/",
      "/call/916-123-45-67/",
      "/u/ivan_petrov/",
      "/u/ivan.petrov/",
      "/u/Ivan/",
      "/street/ulitsa-bolshaya-sadovaya-dom/",
    ]) {
      const record = {
        ...kazan,
        name: `ostrovok.ru${path}`,
        page: `https://ostrovok.ru${path}`,
      };
      expect(siteOperationSchema.safeParse(record).success).toBe(false);
    }
    const plain = {
      ...kazan,
      name: "ostrovok.ru/u/ivan/",
      page: "https://ostrovok.ru/u/ivan/",
    };
    expect(siteOperationSchema.safeParse(plain).success).toBe(true);
  });

  it("reads a document's state where its scripts keep it and data split into tables, with no value in a step", () => {
    // What the worker found on the stand (26.10): ozon.ru's grid in an
    // element's data-state, its name atom told by its id; tutu.ru's trains on
    // its own API host, joined from two tables; kassir.ru's Nuxt payload;
    // litres.ru's Next.js flight; 2gis.ru's assigned state, a table's values.
    const ozon = {
      fields: {
        link: { path: ["action", "link"] },
        name: ["mainState", { with: ["id", "name"] }, "textDS", "text"],
        price: [
          "mainState",
          { with: ["type", "priceV2"] },
          "priceV2",
          "price",
          0,
          "text",
        ],
      },
      items: ["items"],
      name: "www.ozon.ru/search/",
      page: "https://www.ozon.ru/search/?text=%query%&deny_category_prediction=%flag%",
      seen: { items: 12, matched: 3, of: 3 },
      source: {
        kind: "document",
        state: { attribute: "data-state", idPrefix: "state-tileGridDesktop-" },
      },
    };
    const tutu = {
      fields: {
        cents: true,
        link: "page",
        name: [
          "routeIds",
          0,
          { at: [0, "dictionary", "common", "routes"] },
          "voyageNumber",
          { at: [0, "dictionary", "train", "voyages"] },
          "numberForPassengers",
        ],
        price: ["offerVariants", "*", "price", "value", "amount"],
      },
      items: [0, "offers", "actual", "*"],
      name: "www.tutu.ru/poezda/%word%/%word%/",
      page: "https://www.tutu.ru/poezda/%word%/%word%/?date=%date%",
      seen: { items: 41, matched: 3, of: 3 },
      source: {
        kind: "xhr",
        method: "POST",
        url: "https://offers-api.tutu.ru/railway/offers",
      },
    };
    const accepted = [
      ozon,
      tutu,
      {
        ...ozon,
        items: ["pinia", "search.store", "searchResultItems"],
        source: {
          kind: "document",
          state: { decode: "devalue", id: "__NUXT_DATA__", tag: "script" },
        },
      },
      {
        ...ozon,
        items: [{ deep: "searchData" }, "data"],
        source: { kind: "document", state: { flight: "next" } },
      },
      {
        ...ozon,
        items: [
          "widgetStates",
          { prefix: "tileGrid-" },
          { json: true },
          "items",
        ],
        source: {
          kind: "document",
          state: { assignment: "_cianConfig.frontend-serp" },
        },
      },
      {
        ...ozon,
        fields: {
          link: {
            parts: [["id"]],
            query: [],
            template: "/catalog/{0}/detail.aspx",
          },
          name: ["name"],
        },
        items: ["state", "$sproducts-list", "productsList"],
      },
    ];
    for (const operation of accepted) {
      expect(siteOperationSchema.safeParse(operation).success).toBe(true);
    }
    const refused = [
      // A step's word that is a value: an id, a key's start with its digits.
      {
        ...ozon,
        fields: { name: ["mainState", { with: ["id", "3669724a"] }] },
      },
      {
        ...ozon,
        items: ["widgetStates", { prefix: "tileGrid-3669724-" }, "items"],
      },
      { ...ozon, items: ["widgetStates", { prefix: "tileGrid" }, "items"] },
      { ...ozon, fields: { name: ["mainState", { with: ["sku", "name"] }] } },
      // A table's id looked up, not the table; a join or "*" inside the items.
      {
        ...tutu,
        fields: {
          ...tutu.fields,
          name: ["routeIds", 0, { at: ["routes", "r12345678"] }],
        },
      },
      { ...tutu, items: [0, "offers", "*", "actual"] },
      { ...tutu, items: [0, { at: ["offers"] }] },
      {
        ...tutu,
        fields: {
          ...tutu.fields,
          name: [
            "a",
            { at: ["t"] },
            "b",
            { at: ["t"] },
            "c",
            { at: ["t"] },
            "d",
            { at: ["t"] },
          ],
        },
      },
      { ...tutu, fields: { ...tutu.fields, cents: false } },
      // A minifier's local, an attribute that is no data-*, a page's file name of another kind.
      { ...ozon, source: { kind: "document", state: { assignment: "i" } } },
      {
        ...ozon,
        source: { kind: "document", state: { attribute: "onclick", index: 0 } },
      },
      {
        ...ozon,
        name: "www.ozon.ru/search/ivan.petrov",
        page: "https://www.ozon.ru/search/ivan.petrov",
      },
    ];
    for (const record of refused) {
      expect(siteOperationSchema.safeParse(record).success).toBe(false);
    }
    // Only a worker from 26.10 reads such a state, step or price in kopecks.
    for (const operation of accepted) {
      expect(siteOperationWorker(siteOperationSchema.parse(operation))).toBe(
        "2026-10-26.1"
      );
    }
    expect(siteOperationWorker(kazan)).toBeUndefined();
  });

  it("reads a page's rows by the site's own hooks, never a build's hashed class or a value", () => {
    // What the worker learned on the stand (26.10, `site_rows_operations`).
    const labirint = {
      fields: { link: { path: ["link"] }, name: ["name"], price: ["price"] },
      items: [],
      name: "www.labirint.ru/search/%id%/",
      page: "https://www.labirint.ru/search/%id%/",
      seen: { items: 60, matched: 0, of: 0 },
      source: {
        cells: {
          link: { attribute: "href", selector: "a.product-card__img" },
          name: { selector: "a.product-card__name" },
          price: { attribute: "data-discount-price", selector: ":scope" },
        },
        kind: "html",
        render: false,
        rows: "div.product-card",
      },
    };
    const twogis = {
      fields: { link: { path: ["link"] }, name: ["name"] },
      items: [],
      name: "2gis.ru/moscow/search/%word%",
      page: "https://2gis.ru/moscow/search/%word%",
      seen: { items: 12, matched: 0, of: 0 },
      source: {
        cells: {
          link: { attribute: "href", selector: 'a[href*="/firm/"]' },
          name: { selector: 'a[href*="/firm/"]' },
        },
        kind: "html",
        render: false,
        rows: 'div:has(> div > div > a[href*="/firm/"])',
      },
    };
    const tutu = {
      fields: { link: "page", name: ["name"], price: ["price"] },
      items: [],
      name: "www.tutu.ru/poezda/%word%/%word%/",
      page: "https://www.tutu.ru/poezda/%word%/%word%/?date=%date%&travelers=%number%",
      seen: { items: 10, matched: 0, of: 0 },
      source: {
        cells: {
          name: { selector: 'div[data-ti="train-name-badge"]' },
          price: { selector: 'span[data-ti="first-price"]' },
        },
        kind: "html",
        render: true,
        rows: 'div[data-ti="offersList"] > div',
        twins: true,
      },
    };
    for (const operation of [labirint, twogis, tutu]) {
      const kept = siteOperationSchema.parse(operation);
      expect(kept).toEqual(operation);
      // An older worker does not read an html operation at all.
      expect(siteOperationWorker(kept)).toBe("2026-10-26.2");
    }
    const rows = (selector: string) => ({
      ...labirint,
      source: { ...labirint.source, rows: selector },
    });
    const name = (cell: { attribute?: string; selector: string }) => ({
      ...labirint,
      source: {
        ...labirint.source,
        cells: { ...labirint.source.cells, name: cell },
      },
    });
    const refused = [
      // A build's hashed classes: they change with every release.
      rows("div.c0e_7"),
      rows("div.x31de4314--8d758a--text"),
      rows("div.knfjIn"),
      name({ selector: "span.tsBody500Medium" }),
      // A text value in a selector: what a card or a person says.
      rows('div[title="Мастер и Маргарита"]'),
      name({ selector: 'a[aria-label="Мастер и Маргарита"]' }),
      // The errand's own words: a search in another alphabet, a number, a
      // link by a part of its path that is a value.
      rows('div[data-name="Гарри Поттер"]'),
      rows('div[data-testid="iphone 15"]'),
      rows('a[href*="/79217818876/"]'),
      // Positions and anything beyond the grammar.
      rows("li:nth-child(2)"),
      rows("div:not(.ad)"),
      rows('a[href^="/books/"]'),
      rows("div > > a"),
      name({ attribute: "onclick", selector: "a" }),
      // Its data is its rows' cells as they are, never paths into data.
      { ...labirint, items: ["rows"] },
      { ...labirint, fields: { ...labirint.fields, name: ["title"] } },
      {
        ...labirint,
        fields: { ...labirint.fields, link: { path: ["href"] } },
      },
    ];
    for (const record of refused) {
      expect(siteOperationSchema.safeParse(record).success).toBe(false);
    }
  });

  it("is the site's on its own host and the site's subdomains, never a neighbour's", () => {
    expect(siteOperationOnSite(kazan, "https://www.ostrovok.ru")).toBe(true);
    expect(siteOperationOnSite(kazan, "https://ostrovok.ru/hotel")).toBe(true);
    expect(siteOperationOnSite(kazan, "https://m.ostrovok.ru")).toBe(true);
    const city = {
      ...kazan,
      name: "kazan.ostrovok.ru/hotel/",
      page: "https://kazan.ostrovok.ru/hotel/",
      source: { ...kazan.source, url: "https://kazan.ostrovok.ru/api/serp" },
    };
    expect(siteOperationSchema.safeParse(city).success).toBe(true);
    expect(siteOperationOnSite(city, "https://www.ostrovok.ru")).toBe(true);
    expect(siteOperationOnSite(city, "https://spb.ostrovok.ru")).toBe(false);
    expect(siteOperationOnSite(kazan, "https://notostrovok.ru")).toBe(false);
    const shop = {
      ...kazan,
      name: "shop.msk.ru/catalog/",
      page: "https://shop.msk.ru/catalog/",
      source: { ...kazan.source, url: "https://shop.msk.ru/api/v2/catalog" },
    };
    expect(siteOperationSchema.safeParse(shop).success).toBe(true);
    expect(siteOperationOnSite(shop, "https://other.msk.ru")).toBe(false);
  });

  it("makes two finds that differ in a part of the page's path one, with a placeholder there", () => {
    const moscow = {
      ...kazan,
      name: "ostrovok.ru/hotel/russia/moscow/",
      page: kazan.page.replace("kazan", "moscow"),
    };
    expect(mergeSiteOperations(kazan, moscow)).toMatchObject({
      name: "ostrovok.ru/hotel/russia/%word%/",
      page: "https://ostrovok.ru/hotel/russia/%word%/?dates=%date%&guests=%number%&sort=%sort%",
    });
    // Data from elsewhere, or a path of another shape, is another operation.
    expect(
      mergeSiteOperations(kazan, { ...moscow, items: ["hotels"] })
    ).toBeUndefined();
    expect(
      mergeSiteOperations(kazan, {
        ...moscow,
        name: "ostrovok.ru/hotel/russia/moscow/center/",
        page: "https://ostrovok.ru/hotel/russia/moscow/center/",
      })
    ).toBeUndefined();
  });

  it("reads an address of another city as a loose fit, never one of another shape or site", () => {
    expect(
      siteReadFit(
        kazan,
        "https://ostrovok.ru/hotel/russia/kazan/?dates=07.11.2026-09.11.2026&guests=2"
      )
    ).toBe("exact");
    expect(
      siteReadFit(
        kazan,
        "https://ostrovok.ru/hotel/russia/sochi?sort=price.asc"
      )
    ).toBe("loose");
    for (const address of [
      "https://ostrovok.ru/hotel/russia/sochi/?dates=x&token=1",
      "https://ostrovok.ru/hotel/russia/",
      "https://ostrovok.ru/hotel/russia/sochi/mid1/",
      "https://ostrovok.evil.ru/hotel/russia/sochi/",
      "http://ostrovok.ru/hotel/russia/sochi/",
      "https://user:pass@ostrovok.ru/hotel/russia/sochi/",
      "https://ostrovok.ru/hotel/russia/so%3Cchi/",
      "not an address",
    ]) {
      expect(siteReadFit(kazan, address)).toBeUndefined();
    }
  });

  it("reads a search's words with spaces in a part of the path the template writes as a query", () => {
    // labirint.ru writes the search in its path (26.10): as `%id%` the fill took it for one book's page.
    const labirint = siteOperationSchema.parse({
      fields: { link: { path: ["link"] }, name: ["name"], price: ["price"] },
      items: [],
      name: "www.labirint.ru/search/%query%/",
      page: "https://www.labirint.ru/search/%query%/?stype=%number%",
      seen: { items: 60, matched: 0, of: 0 },
      source: {
        cells: {
          link: { attribute: "href", selector: "a.product-card__img" },
          name: { selector: "a.product-card__name" },
        },
        kind: "html",
        render: false,
        rows: "div.product-card",
      },
    });
    expect(siteOperationWorker(labirint)).toBe("2026-10-26.3");
    for (const address of [
      "https://www.labirint.ru/search/анна каренина/?stype=0",
      "https://www.labirint.ru/search/%D0%B0%D0%BD%D0%BD%D0%B0%20%D0%BA%D0%B0%D1%80%D0%B5%D0%BD%D0%B8%D0%BD%D0%B0/",
      "https://www.labirint.ru/search/гарри поттер 3/",
    ]) {
      expect(siteReadFit(labirint, address)).toBe("exact");
    }
    for (const address of [
      "https://www.labirint.ru/search/анна/каренина/",
      "https://www.labirint.ru/search/%25query%25/",
      "https://www.labirint.ru/search/a%3Cb/",
    ]) {
      expect(siteReadFit(labirint, address)).toBeUndefined();
    }
    // A word the template kept, or a `%word%`, takes no spaces still.
    expect(
      siteReadFit(kazan, "https://ostrovok.ru/hotel/russia/nizhny novgorod/")
    ).toBeUndefined();
  });

  it("widens an operation that read a loose page: its path's other words become placeholders", () => {
    const wider = widenedSiteOperation(
      kazan,
      "https://ostrovok.ru/hotel/russia/sochi/?dates=x"
    );
    expect(wider?.name).toBe("ostrovok.ru/hotel/russia/%word%/");
    expect(wider?.page).toBe(
      "https://ostrovok.ru/hotel/russia/%word%/?dates=%date%&guests=%number%&sort=%sort%"
    );
    expect(
      siteReadFit(wider ?? kazan, "https://ostrovok.ru/hotel/russia/moscow/")
    ).toBe("exact");
  });

  it("tells the code engine what each operation takes and gives", () => {
    const line = siteOperationsLine([kazan]);
    expect(line).toContain(
      'op("ostrovok.ru/hotel/russia/kazan/", url) for a results page like https://ostrovok.ru/hotel/russia/kazan/?dates=%date%&guests=%number%&sort=%sort% (cards with name, price, link, more)'
    );
    expect(line).toContain("If op() fails, go on with the page as usual.");
    expect(siteOperationsLine([])).toBeUndefined();
    expect(
      errandSite("Найди отель.\n\nSite: https://ostrovok.ru\n\nFirst")
    ).toBe("https://ostrovok.ru");
    expect(errandSite("Найди отель.")).toBeUndefined();
  });
});

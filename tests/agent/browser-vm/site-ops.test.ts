import { describe, expect, it } from "vitest";
import { knownSiteOperations } from "@agent/lib/browser-vm/site-ops/known";
import {
  mergeSiteOperations,
  type SiteOperation,
  siteOperationOnSite,
  siteOperationSchema,
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
      // Another host of the same last two labels is not the site.
      {
        ...kazan,
        source: {
          ...kazan.source,
          url: "https://api.ostrovok.ru/hotel/search/v2/site/serp",
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

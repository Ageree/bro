import { describe, expect, it } from "vitest";
import { knownSiteOperations } from "@agent/lib/browser-vm/site-ops/known";
import {
  mergeSiteOperations,
  type SiteOperation,
  siteOperationSchema,
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
    ];
    for (const record of records) {
      expect(siteOperationSchema.safeParse(record).success).toBe(false);
    }
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

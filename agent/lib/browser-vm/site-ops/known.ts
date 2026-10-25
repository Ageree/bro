import type { SiteOperation } from "./operation";

/**
 * Operations every workspace of the pilot gets, each one a workspace's
 * find on the worker's stand (25.10) on a page with no sign-in, read
 * through by a person and then made broader by hand: a workspace's own
 * finds stay with it (`browser_site_operations`). Each holds templates
 * only: no value of a run, no cookie, no header, no body.
 *
 * hh.ru's search page carries its 50 vacancies in the state of its
 * document; ostrovok.ru's results page asks its serp for the hotels, and
 * the answer holds every available hotel of the city on its map (2 676 in
 * Kazan, each with its price for the whole stay and its rating). The page
 * builds its serp from its own filters (`type_group=hotel`,
 * `reviews_rating=8`, as the site's note has them): with the rating one,
 * Sochi's 2 955 hotels were 1 258 on the stand (25.10).
 */
export const knownSiteOperations: readonly SiteOperation[] = [
  {
    about:
      'price is the pay from, a month, in more["compensation.currencyCode"] (RUR is roubles), more["compensation.to"] its top; more["company.visibleName"] is the employer',
    fields: {
      link: { path: ["links", "desktop"] },
      name: ["name"],
      price: ["compensation", "from"],
    },
    items: ["vacancySearchResult", "vacancies"],
    name: "hh.ru/search/vacancy",
    page: "https://hh.ru/search/vacancy?text=%query%&area=%number%&salary=%number%&only_with_salary=%flag%",
    seen: { items: 50, matched: 5, of: 6 },
    source: {
      kind: "document",
      state: { id: "HH-Lux-InitialState", tag: "template" },
    },
  },
  {
    about:
      "price is for the whole stay and all the guests, in roubles; more.rating is out of 10, more.stars the stars times ten",
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
    name: "ostrovok.ru/hotel/%word%/%word%/",
    page: "https://ostrovok.ru/hotel/%word%/%word%/?dates=%date%&guests=%number%&sort=%sort%&type_group=%word%&reviews_rating=%number%",
    seen: { items: 2676, matched: 3, of: 3 },
    source: {
      kind: "xhr",
      method: "POST",
      url: "https://ostrovok.ru/hotel/search/v2/site/serp",
    },
  },
];

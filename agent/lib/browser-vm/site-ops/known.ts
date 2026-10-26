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
 *
 * The rest were found on the stand on 26.10, where the operations of 25.10
 * found nothing, and each read three other searches right live: ozon.ru
 * keeps its grid as JSON in an element's data-state, each item's name told
 * from its other atoms by its id; wildberries.ru asks its own host for the
 * search and prices it in kopecks; tutu.ru asks its API host, and a train's
 * number is three tables away from its offer; litres.ru's results are in
 * its Next.js flight; youla.ru asks its GraphQL host. labirint.ru,
 * petrovich.ru and kinopoisk.ru keep their results in no data at all: their
 * rows are read from the results document by the site's own hooks (the
 * worker's look, 26.10), each read live again on the stand; labirint.ru
 * writes the search's words in its path.
 *
 * `inputs` are what each site sorted, bounded and paged by itself on the
 * stand (26.10, read back live): a price order over its whole search where
 * a sort here sees its first page only. wildberries.ru's `page` and
 * labirint.ru's (which drops its order) are left out; litres.ru took none.
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
    inputs: {
      page: { first: 0, key: "page" },
      sort: { desc: "order_by=salary_desc" },
    },
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
    inputs: { sort: { asc: "sort=price.asc" } },
    name: "ostrovok.ru/hotel/%word%/%word%/",
    page: "https://ostrovok.ru/hotel/%word%/%word%/?dates=%date%&guests=%number%&sort=%sort%&type_group=%word%&reviews_rating=%number%",
    seen: { items: 2676, matched: 3, of: 3 },
    source: {
      kind: "xhr",
      method: "POST",
      url: "https://ostrovok.ru/hotel/search/v2/site/serp",
    },
  },
  {
    about:
      "deny_category_prediction is always true, so the site keeps to the search; price is the card's price in roubles as the site writes it",
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
    inputs: {
      page: { first: 1, key: "page" },
      price: { decimals: 3, range: "currency_price", unit: "rub" },
      sort: { asc: "sorting=price", desc: "sorting=price_desc" },
    },
    name: "www.ozon.ru/search/",
    page: "https://www.ozon.ru/search/?text=%query%&deny_category_prediction=%flag%",
    seen: { items: 8, matched: 4, of: 4 },
    source: {
      kind: "document",
      state: { attribute: "data-state", idPrefix: "state-tileGridDesktop-" },
    },
  },
  {
    about:
      "the number in the path is always 0; price is in roubles before the wallet discount the site takes off itself",
    fields: {
      cents: true,
      link: {
        parts: [["id"]],
        query: [],
        template: "/catalog/{0}/detail.aspx",
      },
      name: ["name"],
      price: ["sizes", 0, "price", "product"],
    },
    items: ["products"],
    inputs: {
      price: { decimals: 0, range: "priceU", unit: "kop" },
      sort: { asc: "sort=priceup", desc: "sort=pricedown" },
    },
    name: "www.wildberries.ru/catalog/%id%/search.aspx",
    page: "https://www.wildberries.ru/catalog/%id%/search.aspx?search=%query%",
    seen: { items: 100, matched: 5, of: 5 },
    source: {
      kind: "xhr",
      method: "GET",
      url: "https://www.wildberries.ru/%id%/u-search/exactmatch/ru/common/v18/search",
    },
  },
  {
    about:
      "the two words are the cities as tutu.ru writes them in latin (Moskva, Sankt-Peterburg, Kazan), date as 05.11.2026, travelers 1; name is the train's number, price its least fare in roubles; more holds its departure and arrival",
    fields: {
      cents: true,
      link: "page",
      name: [
        "routeIds",
        0,
        { at: [0, "dictionary", "common", "routes"] },
        "segmentIds",
        0,
        { at: [0, "dictionary", "common", "segments"] },
        "voyageNumber",
        { at: [0, "dictionary", "train", "voyages"] },
        "numberForPassengers",
      ],
      price: ["offerVariants", "*", "price", "value", "amount"],
    },
    items: [0, "offers", "actual", "*"],
    name: "www.tutu.ru/poezda/%word%/%word%/",
    page: "https://www.tutu.ru/poezda/%word%/%word%/?date=%date%&travelers=%number%",
    seen: { items: 41, matched: 6, of: 6 },
    source: {
      kind: "xhr",
      method: "POST",
      url: "https://offers-api.tutu.ru/railway/offers",
    },
  },
  {
    about:
      "price is in roubles; a book, its audiobook and its other editions are results of their own",
    fields: {
      link: { path: ["instance", "url"] },
      name: ["instance", "title"],
      price: ["instance", "prices", "final_price"],
    },
    items: [{ deep: "searchData" }, "data"],
    name: "www.litres.ru/search/",
    page: "https://www.litres.ru/search/?q=%query%",
    seen: { items: 24, matched: 4, of: 4 },
    source: { kind: "document", state: { flight: "next" } },
  },
  {
    about:
      "the word in the path is the city as youla.ru writes it (moskva, sankt-peterburg); price is the ad's price as the site writes it",
    fields: {
      link: { path: ["product", "url"] },
      name: ["product", "name"],
      price: ["product", "price", "realPriceText"],
    },
    items: ["data", "feed", "items"],
    name: "youla.ru/%word%",
    page: "https://youla.ru/%word%?q=%query%",
    seen: { items: 36, matched: 5, of: 5 },
    source: {
      kind: "xhr",
      method: "POST",
      url: "https://api-gw.youla.ru/graphql",
    },
  },
  {
    about:
      "price is the price with the site's discount, in roubles; a book's other editions are results of their own",
    fields: { link: { path: ["link"] }, name: ["name"], price: ["price"] },
    items: [],
    inputs: {
      price: { max: "price_max", min: "price_min" },
      sort: {
        asc: "order=price&way=forward",
        desc: "order=price&way=back",
      },
    },
    name: "www.labirint.ru/search/%query%/",
    page: "https://www.labirint.ru/search/%query%/",
    seen: { items: 60, matched: 4, of: 4 },
    source: {
      cells: {
        link: { attribute: "href", selector: "a.product-card__img" },
        name: { attribute: "data-name", selector: ":scope" },
        price: { attribute: "data-discount-price", selector: ":scope" },
      },
      kind: "html",
      render: false,
      rows: "div.product-card",
    },
  },
  {
    about:
      "price is the shop's price in Moscow, in roubles, as the site writes it",
    fields: { link: { path: ["link"] }, name: ["name"], price: ["price"] },
    items: [],
    inputs: {
      page: { first: 1, key: "p" },
      sort: { asc: "sort=price_asc", desc: "sort=price" },
    },
    name: "moscow.petrovich.ru/search/",
    page: "https://moscow.petrovich.ru/search/?q=%query%",
    seen: { items: 20, matched: 3, of: 3 },
    source: {
      cells: {
        link: { attribute: "href", selector: 'a[data-test="product-link"]' },
        name: { selector: 'span[data-test="product-title"]' },
        price: { selector: 'p[data-test="product-gold-price"]' },
      },
      kind: "html",
      render: false,
      rows: "div.page-item",
    },
  },
  {
    about:
      "films, series and people named by the search, the best match first; no price",
    fields: { link: { path: ["link"] }, name: ["name"] },
    items: [],
    name: "www.kinopoisk.ru/index.php",
    page: "https://www.kinopoisk.ru/index.php?kp_query=%query%",
    seen: { items: 12, matched: 3, of: 4 },
    source: {
      cells: {
        link: { attribute: "href", selector: "p.name a.js-serp-metrika" },
        name: { selector: "p.name a.js-serp-metrika" },
      },
      kind: "html",
      render: false,
      rows: "div.element",
      twins: true,
    },
  },
];

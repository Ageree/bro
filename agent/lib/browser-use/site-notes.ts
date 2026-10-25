import { env } from "@shared/environment";

/**
 * What a run should know of a site before it opens it: how the site builds
 * the address of its results, so the run opens them at once instead of
 * filling the search form and its calendar (roadmap item 26, docs/browser-speed.md).
 * On the worker's stand on 25.10, with the code engine, tutu.ru took 89 s
 * with its note against 184–247 s without, and Ostrovok 74 s and 11 calls
 * against 155–244 s: the runs without spent most of their calls on the date
 * pickers. Each address here was seen open on the stand; a note says only
 * how a site's own addresses are written, never what to pick.
 *
 * Checked on 25.10 with the stand's Chromium and its code engine (cards(),
 * a result list read back and compared with what the address asked for):
 * ostrovok.ru (type_group=hotel and reviews_rating=8 keep only hotels rated
 * 8 and up; rating=8 changes nothing; a price= range gave a list that did not
 * match the cards' prices, so it stays out), citilink.ru (sorting=price_asc
 * gives rising prices; price_min/price_max change nothing). ozon.ru was
 * read as plain HTML with curl, the stand's browser is turned away at its
 * door: sorting=price and sorting=rating gave rising prices and ratings of
 * 5.0 first, the same card fields as listed. The stand's address is outside
 * Russia, so wildberries.ru, avito.ru, dns-shop.ru and lemanapro.ru show an
 * anti-bot check there: nothing about their results could be seen.
 */
const siteNotes: readonly {
  readonly hosts: readonly string[];
  readonly note: string;
}[] = [
  {
    hosts: ["tutu.ru"],
    note: "trains for a date open straight at https://www.tutu.ru/poezda/<From>/<To>/?date=DD.MM.YYYY, the cities in Latin as the site writes them (Moskva, Sankt-Peterburg, Kazan): skip the search form and its calendar. Each train is a card there with its number, times and prices from; scroll to the bottom to load them all.",
  },
  {
    hosts: ["ostrovok.ru"],
    note: "hotels for dates open straight at https://ostrovok.ru/hotel/russia/<city>/?dates=DD.MM.YYYY-DD.MM.YYYY&guests=<number of guests>&sort=price.asc&type_group=hotel&reviews_rating=8, the city in Latin as in the site's own addresses (kazan, moscow): skip the form, its calendar and its filters. sort=price.asc is cheapest first; type_group=hotel keeps the site's class «Отели, меблированные комнаты» (leave it out for apartments); reviews_rating=8 keeps a guest rating of 8 and up (use the number the errand asks for; plain rating= does nothing). Filter the price in your own code: each hotel is a card with its name, rating and the price of the whole stay for all the guests (divide it by the nights for a night's price); a card whose room is «Кровать в общем номере» is a bed in a dorm, not a hotel room.",
  },
  {
    hosts: ["hh.ru"],
    note: "vacancies open straight at https://hh.ru/search/vacancy?text=<words>&area=1 (1 is Moscow, 2 Saint Petersburg), with &salary=<roubles>&only_with_salary=true for a pay floor; a vacancy's own page is https://hh.ru/vacancy/<id>.",
  },
  {
    hosts: ["citilink.ru"],
    note: "its search opens straight at https://www.citilink.ru/search/?text=<words>&sorting=price_asc (cheapest first across everything the search found, so the first cards may be another size or model: keep the ones that fit in your code; price_min and price_max in the address do nothing). Each product is a card with its price (some show two, one marked «Клубная цена»), its name, rating, number of reviews and stock, and a link to its page.",
  },
  {
    hosts: ["ozon.ru"],
    note: "its search opens straight at https://www.ozon.ru/search/?text=<words>&from_global=true&sorting=price (cheapest first; sorting=rating is best rated first). Each product is a card with its price (marked when it is the Ozon Card price), the old price struck out, its name, seller, rating and number of reviews, and a delivery date: filter by price and rating in your own code.",
  },
  // The next two were NOT seen open: the stand's address is turned away by both. Their parameter names
  // (Avito's pmin, pmax and s) are in the sites' own robots.txt (read 25.10), the values are from what is
  // generally known of the sites. Check them on a test account before relying on them.
  {
    hosts: ["wildberries.ru"],
    note: "its search opens straight at https://www.wildberries.ru/catalog/0/search.aspx?search=<words>&sort=priceup (cheapest first). Each product is a card with its price, brand and name, rating and number of reviews: filter by rating in your own code.",
  },
  {
    hosts: ["avito.ru"],
    note: "a search opens straight at https://www.avito.ru/<city>?q=<words> (the city as the site writes it in its own addresses: moskva, sankt-peterburg), with &pmin=<roubles> and &pmax=<roubles> for the price and &s=1 for cheapest first. Each ad is a card with its title, price, place and date.",
  },
  {
    hosts: ["dns-shop.ru"],
    note: "its search opens straight at https://www.dns-shop.ru/search/?q=<words>.",
  },
  {
    hosts: ["lemanapro.ru"],
    note: "its search opens straight at https://lemanapro.ru/search/?q=<words>.",
  },
];

/**
 * The line about the errand's site for its task (`composeBrowserTask`), in
 * the pilot (BROWSER_SITE_NOTES_WORKSPACES: workspace ids or `*`); undefined
 * for a site with no note, outside the pilot, or for an address that does
 * not parse. A subdomain counts as its site (m.lemanapro.ru).
 */
export function siteNoteLine(
  scope: { readonly workspaceId: string },
  site: string | undefined
) {
  const pilot = env.BROWSER_SITE_NOTES_WORKSPACES ?? [];
  if (!pilot.includes("*") && !pilot.includes(scope.workspaceId)) {
    return undefined;
  }
  const host = site === undefined ? undefined : URL.parse(site)?.hostname;
  if (!host) return undefined;
  const found = siteNotes.find(({ hosts }) =>
    hosts.some((name) => host === name || host.endsWith(`.${name}`))
  );
  return found === undefined ? undefined : `About this site: ${found.note}`;
}

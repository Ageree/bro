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
    note: "hotels for dates open straight at https://ostrovok.ru/hotel/russia/<city>/?dates=DD.MM.YYYY-DD.MM.YYYY&guests=<number of guests>, the city in Latin as in the site's own addresses (kazan, moscow), cheapest first with &sort=price.asc: skip the form and its calendar. Each hotel is a card with its name, rating and the price of the whole stay.",
  },
  {
    hosts: ["hh.ru"],
    note: "vacancies open straight at https://hh.ru/search/vacancy?text=<words>&area=1 (1 is Moscow, 2 Saint Petersburg), with &salary=<roubles>&only_with_salary=true for a pay floor; a vacancy's own page is https://hh.ru/vacancy/<id>.",
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

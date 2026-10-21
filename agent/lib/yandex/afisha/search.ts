import { z } from "zod";
import { defineYandexOperation } from "../operations";

/** The page's own search request; the server-side one sends the same. */
export const afishaSearchGraphql =
  "query BroSearch($text: String!, $docs: Int!) { search(text: $text, groups: 5, docs: $docs, page: 0, filterByDeviceType: web, filterByTypes: [event], groupBy: groupCode) { groups { code title documentsTotal documents { object { __typename ... on SearchObjectEvent { id url title placeTitle minPrice { value } datePreview { text } type { name } tickets { saleStatus } } } } } } }";

/**
 * The listing the rubric pages and the calendar of Afisha use. The search
 * above takes only words and no days; this one takes a kind of event
 * (`tags`), days (`dates`: the first day and how many) and, optionally, words
 * that match titles. `preview` is worded for the asked days.
 */
export const afishaListingGraphql =
  "query BroListing($search: String, $tags: [String], $dates: DaysIntervalInput, $paging: PagingInput!) { actualEvents(search: $search, tags: $tags, dates: $dates, paging: $paging, sort: rank) { items { event { id url title type { name } tickets(dates: $dates) { minPrice { value } saleStatus } } scheduleInfo { placePreview preview { text } } } } }";

/** The rubrics of Afisha's menu that people ask for by name. */
const categories = [
  "concert",
  "theatre",
  "cinema",
  "standup",
  "kids",
  "art",
  "excursions",
  "sport",
  "show",
  "musical",
  "quest",
  "lectures",
  "masterclass",
  "circus_show",
] as const;

/** A day as YYYY-MM-DD, or none: a model that fills every field leaves «». */
const day = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2})?$/u)
  .default("");

const event = z.object({
  id: z.string(),
  kind: z.string().nullable(),
  minPrice: z.number().nullable(),
  sale: z.string().nullable(),
  title: z.string(),
  url: z.string(),
  venue: z.string().nullable(),
  when: z.string().nullable(),
});

/**
 * Events on Yandex Afisha: for words (the title or name), or for a kind of
 * event and days, which the words alone cannot ask. The title, the kind, the
 * venue, the dates as Afisha words them and the lowest ticket price. The
 * search needs no sign-in; a ticket is bought by browser_task, with the
 * person's yes.
 */
export const afishaSearchOperation = defineYandexOperation({
  about:
    "Events on Yandex Afisha: title, kind (theatre, concert…), venue, dates as Afisha words them, the lowest ticket price in rubles and the link. By title or name: query (for example «джаз»), never a kind of event. By kind and days: category (concert, theatre, cinema, standup, kids, art for exhibitions, excursions, sport, show, musical, quest, lectures, masterclass, circus_show) with from and to (YYYY-MM-DD, calendar days of the city, both included; to defaults to from) and the most popular first: «концерты на следующей неделе» is category concert and that week's dates, no query; «кино в выходные» is category cinema with the Saturday and Sunday. If the result has queryDropped, no title had those words and the events are all of that kind for those days: say so. Leave an unused argument empty. Also takes an optional city slug (default moscow) and limit (1 to 10, default 10).",
  access: "read",
  // Prod, 21.10: the events went out as a list and, below it, one line
  // «Ссылки: …» with the links of some of them. The same ask in the prompt
  // and in `about` did not hold, a result's note does.
  answerNote:
    "Note for the answer: write the events as a list, one line each — «• [Название](its url from the list above) — Площадка, 31 окт, 19:00, от 3 700 ₽» (title as it is, the venue, the date as Afisha words it, the lowest price; leave out what is null). The event's own name is its link, and every event above has its url, so every line carries one. No line of links at the end, no «Источник:» line, and nothing the list does not show.",
  args: z.object({
    category: z.enum(["", ...categories]).default(""),
    city: z
      .string()
      .regex(/^[a-z][a-z-]{1,40}$/u)
      .default("moscow"),
    from: day,
    limit: z.number().int().min(1).max(10).default(10),
    query: z.string().trim().max(200).default(""),
    to: day,
  }),
  id: "afisha.search",
  origin: "https://afisha.yandex.ru/robots.txt",
  result: z.union([
    z.object({
      events: z.array(event).max(10),
      // The words that matched no title and were left out of the answer.
      queryDropped: z.string().optional(),
    }),
    z.object({ error: z.string() }),
  ]),
  run: `async function (args) {
  const gql = async (name, query, variables) => {
    const r = await fetch(
      "/api/graphql?city=" + args.city + "&version=604.1.0&query_name=" + name,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-force-cors-preflight": "1" },
        body: JSON.stringify({ operationName: name, variables, query }),
      }
    );
    if (r.status === 401) return { wall: "signed_out" };
    if (r.status !== 200) return { error: "http_" + r.status };
    const j = await r.json();
    if (j.errors) return { error: "gql", message: String(j.errors[0].message).slice(0, 120) };
    return j.data;
  };
  const listed = (data) => {
    const out = [];
    for (const x of data.actualEvents.items) {
      const o = x.event;
      const s = x.scheduleInfo;
      const t = o.tickets && o.tickets[0];
      if (!o.title) continue;
      out.push({
        id: o.id,
        kind: o.type ? o.type.name : null,
        minPrice: t && t.minPrice ? t.minPrice.value / 100 : null,
        sale: t ? t.saleStatus ?? null : null,
        title: o.title,
        url: "https://afisha.yandex.ru" + o.url,
        venue: s ? s.placePreview ?? null : null,
        when: s && s.preview ? s.preview.text ?? null : null,
      });
    }
    return out;
  };
  let d;
  let asked = null;
  if (args.category || args.from || args.to || !args.query) {
    // Afisha takes the first day and how many days; 2026-02-30 is no day.
    const stamp = (text) => {
      const ms = Date.parse(text);
      return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text ? null : ms;
    };
    let dates = null;
    if (args.from || args.to) {
      const first = stamp(args.from);
      const last = args.to ? stamp(args.to) : first;
      if (first === null || last === null || last < first) {
        return { status: "ok", data: { error: "bad_dates" } };
      }
      dates = { date: args.from, period: Math.min(Math.round((last - first) / 86400000) + 1, 366) };
    }
    asked = {
      dates,
      paging: { limit: args.limit, offset: 0 },
      search: args.query || null,
      tags: args.category ? [args.category] : null,
    };
    d = await gql("BroListing", ${JSON.stringify(afishaListingGraphql)}, asked);
  } else {
    d = await gql(
      "BroSearch",
      ${JSON.stringify(afishaSearchGraphql)},
      { text: args.query, docs: args.limit }
    );
  }
  if (d.wall) return { status: "signed_out" };
  if (d.error || !(d.search || d.actualEvents)) return { status: "ok", data: { error: d.error || "gql" } };
  if (d.actualEvents) {
    const events = listed(d);
    if (events.length === 0 && asked.search) {
      // The words match titles only. Nothing has them (a model puts the kind of
      // event there): once more without them, and the answer says so.
      const again = await gql("BroListing", ${JSON.stringify(afishaListingGraphql)}, { ...asked, search: null });
      const shown = again.actualEvents ? listed(again) : [];
      if (shown.length > 0) {
        return { status: "ok", data: { events: shown.slice(0, args.limit), queryDropped: asked.search } };
      }
    }
    return { status: "ok", data: { events: events.slice(0, args.limit) } };
  }
  const events = [];
  for (const g of d.search.groups)
    for (const x of g.documents) {
      const o = x.object;
      if (o.__typename !== "SearchObjectEvent") continue;
      events.push({
        id: o.id,
        kind: o.type ? o.type.name : g.title || null,
        minPrice: o.minPrice ? o.minPrice.value / 100 : null,
        sale: o.tickets && o.tickets[0] ? o.tickets[0].saleStatus : null,
        title: o.title,
        url: "https://afisha.yandex.ru" + o.url,
        venue: o.placeTitle || null,
        when: o.datePreview ? o.datePreview.text : null,
      });
    }
  return { status: "ok", data: { events: events.slice(0, args.limit) } };
}`,
  service: "afisha",
});

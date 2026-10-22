import * as z from "zod";
import { defineYandexOperation } from "../operations";
import { zoneSchema } from "./hall";

/**
 * The sessions of one event: when, where, the session's key in the ticket
 * widget (`ticket.id`) and its link. Afisha answers nothing without `dates`.
 */
export const afishaSessionsGraphql =
  "query BroSessions($id: ID!, $dates: DaysIntervalInput) { eventScheduleOtherByDate(id: $id, dates: $dates) { sessions { place { title address } session { datetime ticket { id widgetUrl saleStatus minPrice { value } maxPrice { value } } } } } }";

/** Sessions listed, and how many of them get their hall plan read. */
export const sessionsListed = 8;
export const sessionsZoned = 3;
/** The days looked through when no day is asked. */
export const sessionsAhead = 180;

/** A day as YYYY-MM-DD, or none: a model that fills every field leaves «». */
const day = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2})?$/u)
  .default("");

const session = z.object({
  address: z.string().nullable(),
  link: z.string().nullable(),
  maxPrice: z.number().nullable(),
  maxTickets: z.number().nullable(),
  minPrice: z.number().nullable(),
  sale: z.string().nullable(),
  venue: z.string().nullable(),
  when: z.string().nullable(),
  // `null`: not read — the page's way, a check, or a session past the first.
  zones: z.array(zoneSchema).max(60).nullable(),
});

/**
 * What tickets an Afisha event sells: its sessions and, for each, every zone
 * of the hall with its prices and whether it has seats at all. A zone without
 * seats is bought by count, and the browser that never knew it hunted for
 * seats there (22.10, «Свидание» in Графит): the zones come from the ticket
 * widget's own hall plan, read from the server (`direct.ts`); the page's way
 * lists the sessions only.
 */
export const afishaPricesOperation = defineYandexOperation({
  about:
    "Tickets of an Afisha event: for each session (event: the id from afisha.search; optional date YYYY-MM-DD) its time, venue, sale status, the link to its ticket widget, how many tickets one order takes, and its zones — the zone's name, its prices and the price with the service fee, how many are left, the next price the site announces, and seats: picked on the hall map, or none, when the zone (a dance floor, «входной», «свободная рассадка») is bought by count. Call it before telling the person what tickets there are and before browser_task buys them. Also takes an optional city slug (default moscow).",
  access: "read",
  // Prod, 22.10: a zone without seats went untold, and the person heard that
  // its price could not be bought.
  answerNote:
    "Note for the answer: give every zone of the session the person means, cheapest first, one line each — «• VIP-входной (свободная рассадка) — 4 200 ₽, со сбором 4 620 ₽, без места» or «• Партер — от 1 200 до 6 000 ₽, место выбирается на схеме» — and leave none out; say «без места» for a zone bought by count, and the next price with its date when there is one. When zones is null, that session's zones were not read: do not guess them; browser_task on its link can look at the hall map. To buy, start browser_task on the session's link with the zone's exact name and the number of tickets in the task, and for a zone without seats say there that it is bought by count, with no seat to pick.",
  args: z.object({
    city: z
      .string()
      .regex(/^[a-z][a-z-]{1,40}$/u)
      .default("moscow"),
    date: day,
    event: z.string().regex(/^[0-9A-Za-z]{8,40}$/u),
  }),
  id: "afisha.prices",
  origin: "https://afisha.yandex.ru/robots.txt",
  result: z.union([
    z.object({
      more: z.number(),
      sessions: z.array(session).max(sessionsListed),
    }),
    z.object({ error: z.string() }),
  ]),
  run: `async function (args) {
  // Afisha takes the first day and how many days; 2026-02-30 is no day.
  const stamp = Date.parse(args.date);
  if (args.date && (Number.isNaN(stamp) || new Date(stamp).toISOString().slice(0, 10) !== args.date)) {
    return { status: "ok", data: { error: "bad_date" } };
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
  const r = await fetch(
    "/api/graphql?city=" + args.city + "&version=604.1.0&query_name=BroSessions",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-force-cors-preflight": "1" },
      body: JSON.stringify({
        operationName: "BroSessions",
        query: ${JSON.stringify(afishaSessionsGraphql)},
        variables: {
          dates: args.date ? { date: args.date, period: 1 } : { date: today, period: ${sessionsAhead} },
          id: args.event,
        },
      }),
    }
  );
  if (r.status === 401) return { status: "signed_out" };
  if (r.status !== 200) return { status: "ok", data: { error: "http_" + r.status } };
  const j = await r.json();
  if (j.errors || !j.data || !j.data.eventScheduleOtherByDate) return { status: "ok", data: { error: "gql" } };
  const all = [];
  for (const g of j.data.eventScheduleOtherByDate)
    for (const x of g.sessions || []) {
      const s = x.session || {};
      const t = s.ticket || {};
      const p = x.place || {};
      all.push({
        address: p.address || null,
        link: typeof t.widgetUrl === "string" && t.widgetUrl.startsWith("https://widget.afisha.yandex.ru/") ? t.widgetUrl : null,
        maxPrice: t.maxPrice ? t.maxPrice.value / 100 : null,
        maxTickets: null,
        minPrice: t.minPrice ? t.minPrice.value / 100 : null,
        sale: t.saleStatus || null,
        venue: p.title || null,
        when: s.datetime ? s.datetime.slice(0, 16) : null,
        zones: null,
      });
    }
  all.sort((a, b) => (a.when || "").localeCompare(b.when || ""));
  return {
    status: "ok",
    data: { more: Math.max(all.length - ${sessionsListed}, 0), sessions: all.slice(0, ${sessionsListed}) },
  };
}`,
  service: "afisha",
});

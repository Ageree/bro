import { z } from "zod";
import { defineYandexOperation } from "../operations";

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
 * Events on Yandex Afisha for a query in a city: the title, the kind, the
 * venue, the dates as Afisha words them and the lowest ticket price. The
 * search needs no sign-in; a ticket is bought by browser_task, with the
 * person's yes.
 */
export const afishaSearchOperation = defineYandexOperation({
  about:
    "Events on Yandex Afisha for a query (for example «джаз»): title, kind (theatre, concert…), venue, dates as Afisha words them, the lowest ticket price in rubles and the link. Takes query, an optional city slug (default moscow) and limit (1 to 10, default 10).",
  access: "read",
  args: z.object({
    city: z
      .string()
      .regex(/^[a-z][a-z-]{1,40}$/u)
      .default("moscow"),
    limit: z.number().int().min(1).max(10).default(10),
    query: z.string().min(1).max(200),
  }),
  id: "afisha.search",
  origin: "https://afisha.yandex.ru/moscow",
  result: z.union([
    z.object({ events: z.array(event).max(10) }),
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
  const d = await gql(
    "BroSearch",
    "query BroSearch($text: String!, $docs: Int!) {\\n" +
      "  search(text: $text, groups: 5, docs: $docs, page: 0, filterByDeviceType: web, filterByTypes: [event], groupBy: groupCode) {\\n" +
      "    groups { code title documentsTotal documents { object { __typename ... on SearchObjectEvent { id url title placeTitle minPrice { value } datePreview { text } type { name } tickets { saleStatus } } } } }\\n" +
      "  }\\n" +
      "}",
    { text: args.query, docs: args.limit }
  );
  if (d.wall) return { status: "signed_out" };
  if (d.error || !d.search) return { status: "ok", data: { error: d.error || "gql" } };
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

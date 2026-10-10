import { z } from "zod";
import { defineYandexOperation } from "../operations";

const order = z.object({
  address: z.string().nullable(),
  event: z.string().nullable(),
  id: z.string(),
  number: z.string().nullable(),
  passed: z.boolean().nullable(),
  seats: z.array(z.string()),
  tickets: z.number().nullable(),
  total: z.number().nullable(),
  venue: z.string().nullable(),
  when: z.string().nullable(),
});

/**
 * The person's own Afisha orders: the event, the venue, the time, the seats
 * and the total. Ticket files and the order's codes are left out.
 */
export const afishaTicketsOperation = defineYandexOperation({
  about:
    "The person's own Yandex Afisha orders (tickets bought there): event, venue, time, whether it has passed, seats and total in rubles. Takes an optional limit (1 to 20, default 10) and offset (default 0). Ticket files and codes are not returned.",
  access: "read",
  args: z.object({
    limit: z.number().int().min(1).max(20).default(10),
    offset: z.number().int().min(0).max(1000).default(0),
  }),
  id: "afisha.tickets",
  origin: "https://afisha.yandex.ru/moscow",
  result: z.union([
    z.object({ orders: z.array(order).max(20), total: z.number().nullable() }),
    z.object({ error: z.string() }),
  ]),
  run: `async function (args) {
  const r = await fetch("/api/graphql?city=moscow&version=604.1.0&query_name=BroOrders", {
    method: "POST",
    headers: { "content-type": "application/json", "x-force-cors-preflight": "1" },
    body: JSON.stringify({
      operationName: "BroOrders",
      variables: {},
      query:
        "query BroOrders {\\n" +
        "  orders(paging: { limit: " + args.limit + ", offset: " + args.offset + " }, sort: sessionDate) {\\n" +
        "    paging { total }\\n" +
        "    items { id orderNumber dateTime passed ticketsCount hall total { value } event { title } place { title address } tickets { row place level category } }\\n" +
        "  }\\n" +
        "}",
    }),
  });
  if (r.status === 401) return { status: "signed_out" };
  if (r.status !== 200) return { status: "ok", data: { error: "http_" + r.status } };
  const j = await r.json();
  if (j.errors || !j.data || !j.data.orders) return { status: "ok", data: { error: "gql" } };
  const o = j.data.orders;
  return {
    status: "ok",
    data: {
      orders: (o.items || []).slice(0, args.limit).map((x) => ({
        address: x.place ? x.place.address || null : null,
        event: x.event ? x.event.title || null : null,
        id: x.id,
        number: x.orderNumber || null,
        passed: typeof x.passed === "boolean" ? x.passed : null,
        seats: (x.tickets || []).map((t) =>
          [t.level, t.row && "ряд " + t.row, t.place && "место " + t.place].filter(Boolean).join(", ")
        ),
        tickets: x.ticketsCount ?? null,
        total: x.total ? x.total.value / 100 : null,
        venue: x.place ? x.place.title || null : x.hall || null,
        when: x.dateTime || null,
      })),
      total: o.paging ? o.paging.total ?? null : null,
    },
  };
}`,
  service: "afisha",
});

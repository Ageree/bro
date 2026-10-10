import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { goSession } from "./session";

const ride = z.object({
  currency: z.string().nullable(),
  date: z.string().nullable(),
  from: z.string().nullable(),
  price: z.number().nullable(),
  status: z.string().nullable(),
  tariff: z.string().nullable(),
  to: z.string().nullable(),
});

/**
 * The person's latest Yandex Go rides, read from their own order history:
 * when, from where to where, the price and the tariff. The driver, the car
 * and the phone are left out, and so is any address beyond the street line.
 */
export const goRidesOperation = defineYandexOperation({
  about:
    "The person's latest Yandex Go rides (up to ten): date, from, to, price, tariff and status. Takes an optional limit (1 to 10, default 10).",
  access: "read",
  args: z.object({
    limit: z.number().int().min(1).max(10).default(10),
  }),
  id: "go.rides",
  origin: "https://taxi.yandex.ru/",
  result: z.union([
    z.object({ rides: z.array(ride).max(10) }),
    z.object({ error: z.string() }),
  ]),
  run: `async function (args) {
  ${goSession}
  const session = await goSession();
  if (session.wall || session.error) return goAnswer(session);
  const j = await session.post("/4.0/orderhistory/v2/list", {
    services: { taxi: { image_tags: { size_hint: 9999 }, flavors: ["default"] } },
    range: { results: args.limit },
    country_code: "RU",
    include_service_metadata: true,
  });
  if (j.wall || j.error) return goAnswer(j);
  const rides = (j.orders || [])
    .filter((o) => o.service === "taxi")
    .slice(0, args.limit)
    .map((o) => {
      const d = o.data;
      return {
        currency: d.payment ? d.payment.currency_code : null,
        date: d.created_at || null,
        from: d.route ? d.route.source : null,
        price: d.payment ? d.payment.cost : null,
        status: d.status || null,
        tariff: d.tariff_class || null,
        to: d.route ? d.route.destination : null,
      };
    });
  return { status: "ok", data: { rides } };
}`,
  service: "go",
});

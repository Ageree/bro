import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { goSession } from "./session";

const place = z.union([
  z.string().min(1).max(200),
  z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
]);

const tariff = z.object({
  class: z.string(),
  fixed: z.boolean(),
  name: z.string(),
  pickupMinutes: z.number().nullable(),
  price: z.number().nullable(),
});

const estimateResult = z.union([
  z.object({
    distance: z.string(),
    duration: z.string(),
    from: z.string(),
    tariffs: z.array(tariff).max(10),
    to: z.string(),
  }),
  z.object({
    error: z.literal("address_not_found"),
    which: z.enum(["from", "to"]),
  }),
  z.object({ error: z.string() }),
]);

/**
 * Yandex Go's price estimate between two places, by tariff, with the pickup
 * time. It reads the prices of now (an estimate) and creates no order. The
 * taxi itself is not ordered by this tool: a ride is booked only by
 * browser_task, with the person's yes.
 */
export const goEstimateOperation = defineYandexOperation({
  about:
    "The price and the pickup time of each Yandex Go tariff from one place to another, now (an estimate; it creates no order). from and to are an address text or [longitude, latitude]; near biases the address search to a point. It cannot order a taxi: a ride is ordered only by browser_task, with the person's yes.",
  access: "read",
  args: z.object({
    from: place,
    near: z
      .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
      .default([37.6177, 55.7558]),
    to: place,
  }),
  id: "go.estimate",
  origin: "https://taxi.yandex.ru/",
  result: estimateResult,
  run: `async function (args) {
  ${goSession}
  const session = await goSession();
  if (session.wall || session.error) return goAnswer(session);
  const { post } = session;
  const point = async (query) => {
    if (Array.isArray(query)) return { text: query.join(","), position: query };
    const suggest = await post("/4.0/persuggest/v1/suggest", {
      type: "a",
      client_id: "turboapp-taxi",
      state: { accuracy: 0, location: args.near, fields: [] },
      position: args.near,
      action: "user_input",
      part: query,
      sticky: false,
    });
    if (suggest.wall || suggest.error) return suggest;
    const hit =
      (suggest.results || []).find((r) => r.position && r.type === "address") ||
      (suggest.results || []).find((r) => r.position);
    return hit ? { text: hit.text.trim(), position: hit.position } : { error: "address_not_found" };
  };
  const a = await point(args.from);
  if (a.error || a.wall) return a.wall ? goAnswer(a) : { status: "ok", data: { error: a.error, which: "from" } };
  await new Promise((r) => setTimeout(r, 1000));
  const b = await point(args.to);
  if (b.error || b.wall) return b.wall ? goAnswer(b) : { status: "ok", data: { error: b.error, which: "to" } };
  await new Promise((r) => setTimeout(r, 1000));
  const j = await post("/3.0/routestats", {
    id: session.userId,
    route: [a.position, b.position],
    selected_class: "econom",
    format_currency: true,
    payment: { type: "cash" },
    supported: [],
    requirements: {},
    skip_estimated_waiting: false,
    suggest_alternatives: false,
  });
  if (j.wall || j.error) return goAnswer(j);
  const rub = (s) => Number(String(s).replace(/[^\\d.,]/g, "").replace(",", ".")) || null;
  return {
    status: "ok",
    data: {
      distance: j.distance,
      duration: j.time,
      from: a.text,
      tariffs: (j.service_levels || [])
        .filter((s) => !s.is_hidden)
        .slice(0, 10)
        .map((s) => ({
          class: s.class,
          fixed: s.is_fixed_price,
          name: s.name,
          pickupMinutes: s.estimated_waiting ? Math.round(s.estimated_waiting.seconds / 60) : null,
          price: rub(s.price),
        })),
      to: b.text,
    },
  };
}`,
  service: "go",
});

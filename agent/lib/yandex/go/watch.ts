import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { activeOrderSource } from "./booking";
import { goApiPage, goSession } from "./session";

/**
 * Where a booked ride stands, for the watch that tells the person when to
 * step out (`agent/lib/taxi/watch.ts`). `gone` is Yandex no longer listing
 * the order (over, cancelled, or another ride is on). Not in the registry:
 * the model never calls it.
 *
 * Yandex's `taxiontheway` is read for the time left until the car is at the
 * pickup. Where it keeps it was not seen on a live assigned ride, so it is
 * looked for in two ways that cannot mistake the unit: a numeric field whose
 * name says seconds, and a text of the answer («приедет через 3 мин»).
 * Only while the car is on its way (`driving`), when the minutes are the
 * pickup's and not the trip's. `fields` are the names the answer has, never
 * values, for the log: when the time is not found, they say where to look.
 */
export const goWatchOperation = defineYandexOperation({
  about: "Where a booked Yandex Go ride stands.",
  access: "read",
  args: z.object({ orderId: z.string().min(1).max(100) }),
  id: "go.watch",
  origin: goApiPage,
  result: z.union([
    z.object({ kind: z.literal("gone") }),
    z.object({
      car: z.string().nullable(),
      etaSeconds: z.number().nullable(),
      fields: z.array(z.string()).max(200),
      kind: z.literal("ride"),
      status: z.string().nullable(),
    }),
  ]),
  run: `async function (args) {${goSession}
  const session = await goSession();
  if (session.wall || session.error) return goAnswer(session);
  ${activeOrderSource}
  const found = await activeOrder();
  if (!found || found.orderId !== args.orderId) return { status: "ok", data: { kind: "gone" } };
  const t = found.t;
  const status = typeof t.status === "string" ? t.status : null;
  const d = t.driver || {};
  const car = [d.color, d.car_model || d.model, d.plates || d.car_number].filter((x) => typeof x === "string" && x).join(" ");
  const seconds = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 7200 ? Math.round(v) : null);
  const named = [t, d, t.car || {}, t.performer || {}]
    .flatMap((o) => Object.entries(o))
    .filter(([key]) => /(^|_)(eta|time_left|arrival)(_|$)/i.test(key) && /(sec|seconds)$/i.test(key))
    .map(([, value]) => seconds(value))
    .find((v) => v !== null);
  const texts = [];
  const collect = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 2) return;
    for (const [key, value] of Object.entries(o)) {
      if (typeof value === "string" && /title|description|text|eta|status/i.test(key)) texts.push(value);
      else if (value && typeof value === "object" && !Array.isArray(value)) collect(value, depth + 1);
    }
  };
  collect(t, 0);
  const fromText = texts
    .map((text) => {
      if (/менее минуты|меньше минуты|меньше 1 мин/i.test(text)) return 60;
      const m = /(?:через|за|около)?\\s*(\\d{1,3})\\s*мин/i.exec(text);
      return m ? Number(m[1]) * 60 : null;
    })
    .find((v) => v !== null);
  const etaSeconds = status === "driving" ? (named ?? fromText ?? null) : null;
  const fields = [...Object.keys(t).map((k) => k), ...Object.keys(d).map((k) => "driver." + k)].sort().slice(0, 200);
  return { status: "ok", data: { kind: "ride", status, car: car || null, etaSeconds, fields } };
}`,
  service: "go",
});

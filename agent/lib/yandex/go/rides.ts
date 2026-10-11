import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { runYandexOperation } from "../transport";
import { goApiPage, goSession } from "./session";

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
  origin: goApiPage,
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

const purchaseStatusSchema = z.object({
  orderId: z.string().min(1).max(200),
  rideStatus: z
    .enum([
      "scheduling",
      "scheduled",
      "preexpired",
      "boarding",
      "driving",
      "waiting",
      "calling",
      "transporting",
      "complete",
      "failed",
      "cancelled",
      "expired",
      "search",
      "draft",
    ])
    .nullable(),
  finalFareMinor: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  financialStatus: z.literal("unknown"),
  cashLiabilityKnown: z.boolean(),
});

const purchaseStatusOperation = defineYandexOperation({
  about:
    "Reads only the exact durable Go order, never cancels, and does not infer payment or refund from its ride status.",
  access: "read",
  args: z.strictObject({
    orderId: z.string().min(1).max(200),
    providerUserId: z.string().regex(/^[a-f0-9]{32}$/u),
  }),
  id: "go.purchase_status",
  origin: goApiPage,
  result: purchaseStatusSchema,
  run: `async function (args) {${goSession}
    const data = { orderId: args.orderId, rideStatus: null, finalFareMinor: null, financialStatus: "unknown", cashLiabilityKnown: false };
    const ok = () => ({ status: "ok", data });
    try {
      const session = await goSession();
      if (session.wall || session.error || session.userId !== args.providerUserId) return ok();
      const current = await session.post("/3.0/taxiontheway", {
        orderid: args.orderId, format_currency: true, id: session.userId, show_text: true,
      });
      if (current.wall || current.error) return ok();
      const known = ["scheduling", "scheduled", "preexpired", "boarding", "driving", "waiting", "calling", "transporting", "complete", "failed", "cancelled", "expired", "search", "draft"];
      if (known.includes(current.status)) data.rideStatus = current.status;
      if (data.rideStatus === "complete" && current.currency_rules?.code === "RUB") {
        const money = (value) => {
          if (typeof value !== "string" || !/^(0|[1-9]\\d*)(?:\\.(\\d{1,2}))?$/.test(value)) return null;
          const [whole, fraction = ""] = value.split(".");
          const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
          return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
        };
        const fare = money(current.final_cost_decimal_value);
        const raw = current.final_cost;
        if (fare !== null && (typeof raw === "number" || typeof raw === "string") && money(String(raw)) === fare) {
          data.finalFareMinor = fare;
          data.cashLiabilityKnown = current.payment?.type === "cash" &&
            current.tips?.available === false && current.tips.value === 0 && money(current.tips.decimal_value) === 0;
        }
      }
      return ok();
    } catch { return ok(); }
  }`,
  service: "go",
});

export async function readGoPurchaseStatus(
  workspaceId: string,
  input: z.output<typeof purchaseStatusOperation.args>
) {
  const parsed = purchaseStatusOperation.args.safeParse(input);
  if (!parsed.success) return { kind: "unavailable" as const };
  const outcome = await runYandexOperation(
    workspaceId,
    purchaseStatusOperation,
    parsed.data
  );
  if (outcome.kind !== "ok") return { kind: "unavailable" as const };
  const result = purchaseStatusSchema.safeParse(outcome.data);
  return result.success
    ? { kind: "read" as const, ...result.data }
    : { kind: "unavailable" as const };
}

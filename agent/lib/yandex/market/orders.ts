import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { marketRun } from "./prologue";

const orderId = z.string().regex(/^\d{5,12}$/u);

/**
 * The person's Market orders: the active ones or the finished and cancelled
 * ones, one entry per order or per shared delivery. The list reads the
 * orders widget of the page, not its markup.
 */
export const marketOrdersOperation = defineYandexOperation({
  about:
    "Lists the person's Yandex Market orders: status and date, the delivery method (not the address), the order ids and the item titles. Argument: status, active or completed (default completed), and limit (1-10). Sums are not in the list: use market.order for one order.",
  access: "read",
  args: z.object({
    limit: z.number().int().min(1).max(10).optional(),
    status: z.enum(["active", "completed"]).optional(),
  }),
  id: "market.orders",
  origin: "https://market.yandex.ru/",
  result: z.object({
    count: z.number().int(),
    orders: z.array(
      z.object({
        delivery: z.string().nullable(),
        items: z.array(z.string()),
        orderIds: z.array(z.string()),
        status: z.string(),
      })
    ),
    status: z.enum(["active", "completed"]),
  }),
  run: marketRun(String.raw`const status = args.status || "completed";
const limit = args.limit || 10;
const pg = await getPage(status === "active" ? "/my/orders" : "/my/orders?filter=COMPLETED");
if (pg.error) return pg.error;
// The list is a widget patch (JSON in <noframes>): find the array of groups instead of trusting its path.
let groups = null;
const walk = (o) => {
  if (groups) return;
  if (Array.isArray(o)) {
    if (
      o.length &&
      o.every(
        (x) =>
          x &&
          typeof x === "object" &&
          x.onClick &&
          x.onClick.name === "show_order" &&
          Array.isArray(x.orders)
      )
    ) {
      groups = o;
      return;
    }
    o.forEach(walk);
  } else if (o && typeof o === "object") for (const k in o) walk(o[k]);
};
pg.doc.querySelectorAll('noframes[data-apiary="patch"]').forEach((n) => {
  if (groups || !n.textContent.includes("show_order")) return;
  try {
    walk(JSON.parse(n.textContent).widgets);
  } catch (e) {}
});
if (!groups) {
  if (pg.doc.querySelector('[data-auto="ordersEmptyList"]'))
    return ok({ status, count: 0, orders: [] });
  return fail("bad_response", "orders list widget not found (page layout changed)");
}
const val = (a) => (a || []).map((x) => x.value).filter(Boolean);
// The second line of a group is the delivery method and the address: only the method is kept.
const orders = groups.slice(0, limit).map((g) => ({
  orderIds: g.orders.map((o) => o.id),
  status: val(g.title).join(" "),
  delivery: val(g.subtitle1)[0] || null,
  items: g.orders.flatMap((o) => o.items.map((i) => val(i.title).join(" "))),
}));
return ok({ status, count: orders.length, orders });`),
  service: "market",
});

export const marketOrderOperation = defineYandexOperation({
  about:
    "Reads one Yandex Market order by its number: status and its note, the delivery method and dates (no address, no recipient), the items with prices and quantities, and the totals (discount, delivery, total). Argument: orderId, the number from market.orders.",
  access: "read",
  args: z.object({ orderId }),
  id: "market.order",
  origin: "https://market.yandex.ru/",
  result: z.object({
    created: z.string().nullable(),
    delivery: z.array(z.string()),
    items: z.array(
      z.object({
        oldPrice: z.number().nullable(),
        price: z.number().nullable(),
        qty: z.number().int(),
        title: z.string().nullable(),
      })
    ),
    number: z.string().nullable(),
    orderId: z.string(),
    payment: z.string().nullable(),
    status: z.string().nullable(),
    statusNote: z.string().nullable(),
    totals: z.object({
      delivery: z.number().nullable(),
      discount: z.number().nullable(),
      total: z.number().nullable(),
    }),
  }),
  run: marketRun(String.raw`if (!/^\d{5,12}$/.test(args.orderId)) return fail("bad_argument", "orderId must be digits");
const pg = await getPage("/my/order/" + args.orderId);
if (pg.error) return pg.error;
const { doc } = pg;
const root = doc.querySelector('[data-auto="order-page"]');
if (!root || !root.querySelector('[data-auto="order-number"]'))
  return fail("not_found", "order page missing (wrong id or not your order)");
root.querySelectorAll("script,style,noframes,svg").forEach((x) => x.remove());
const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : null);
const view = root.querySelector('[data-zone-name="orderDetailsView"]');
const head = view && view.querySelector("h4");
// The delivery block is labels only: its values are the pickup point or the address, and the recipient row is not read.
const delivery = [];
root.querySelectorAll('[data-zone-name="orderDeliveryInfoItem"]').forEach((row) => {
  const spans = [...row.querySelectorAll("span")].map((s) => t(s)).filter(Boolean);
  if (spans.length >= 2 && spans[0] !== "Получатель") delivery.push(spans[0]);
});
const items = [...root.querySelectorAll('[data-auto="order-item"]')].map((el) => {
  const box = el.parentElement;
  const spans = [...box.querySelectorAll("span")].map((s) => t(s)).filter(Boolean);
  const qty = spans.find((s) => /^\d+ шт/.test(s));
  const prices = spans
    .filter((s) => /^\d[\d\s]*$/.test(s))
    .map((s) => Number(s.replace(/\s/g, "")));
  return {
    title: spans[0] || null,
    price: prices[0] || null,
    oldPrice: prices[1] || null,
    qty: qty ? Number(qty.match(/\d+/)[0]) : 1,
  };
});
const totals = {};
const txt = t(root);
for (const [key, label] of [
  ["discount", "Скидка на товары"],
  ["delivery", "Доставка"],
  ["total", "Итого"],
]) {
  const m = txt.match(new RegExp(label + "\\s*(–\\s*)?(\\d[\\d\\s\\u00a0]*)\\s*₽"));
  totals[key] = m ? (m[1] ? -1 : 1) * Number(m[2].replace(/\D/g, "")) : null;
}
return ok({
  orderId: args.orderId,
  number: t(root.querySelector('[data-auto="order-number"]')),
  created: (txt.match(/от (\d{1,2} [а-я]+ \d{4})/) || [])[1] || null,
  status: head ? t(head) : null,
  statusNote: head ? t(head.parentElement.nextElementSibling) : null,
  delivery,
  items,
  totals,
  payment: t(root.querySelector('[data-zone-name="payment-info"] span')),
});`),
  service: "market",
});

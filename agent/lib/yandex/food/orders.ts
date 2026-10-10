import { z } from "zod";
import { defineYandexOperation } from "../operations";

const edaOrder = z.object({
  currency: z.string(),
  date: z.string(),
  items: z.array(z.string()),
  itemsTotal: z.number().nullable(),
  orderNr: z.string(),
  place: z.string(),
  service: z.enum(["eda", "lavka"]),
  status: z.string(),
  total: z.number(),
});

const lavkaOrder = z.object({
  canceled: z.boolean(),
  date: z.string(),
  delivery: z.number(),
  items: z.array(
    z.object({ name: z.string(), price: z.number(), qty: z.number() })
  ),
  itemsTotal: z.number(),
  orderNr: z.string(),
  shortId: z.string(),
  status: z.string(),
  total: z.number(),
});

/**
 * The last orders of Yandex Eda, grocery orders from Lavka included: Eda's
 * one list holds both, so the orders of Eda's restaurants come here too.
 */
export const edaOrdersOperation = defineYandexOperation({
  about:
    "The person's latest orders on Yandex Eda, grocery orders from Lavka included (service says which). Argument: limit (1-20, default 10). Use the orders' own dates and statuses; addresses and courier details are not returned.",
  access: "read",
  args: z.object({
    limit: z.number().int().min(1).max(20).default(10),
  }),
  id: "food.eda_orders",
  origin: "https://eda.yandex.ru/",
  result: z.object({ hasMore: z.boolean(), orders: z.array(edaOrder) }),
  run: `async function (args) {
  const headers = {
    "Content-Type": "application/json;charset=UTF-8",
    "X-Platform": "desktop_web",
    "X-App-Version": "18.50.1",
  };
  const response = await fetch("/eats/v1/orders-info/v1/orders", {
    method: "POST",
    headers,
    body: JSON.stringify({ goods_items_limit: 6 }),
  });
  if (response.status === 401) return { status: "signed_out" };
  if (response.status >= 400 && /html/.test(response.headers.get("content-type") || "")) return { status: "captcha" };
  if (response.status !== 200) throw new Error("http " + response.status);
  const body = await response.json();
  const orders = (body.orders || []).slice(0, args.limit).map((order) => {
    const general = order.widgets.general;
    const items = (order.widgets.goods && order.widgets.goods.items) || [];
    return {
      orderNr: order.order_nr,
      service: order.order_nr.endsWith("-grocery") ? "lavka" : "eda",
      place: general.name,
      date: general.date,
      total: Number(general.cost_value),
      currency: general.currency.code,
      status: general.status.text,
      items: items.map((item) => item.title),
      itemsTotal: order.widgets.goods ? order.widgets.goods.total_items_number : null,
    };
  });
  const cursor = body.pagination_settings;
  return {
    status: "ok",
    data: { orders, hasMore: !!(cursor && cursor.has_more) },
  };
}`,
  service: "yandex-eda",
});

/**
 * The last grocery orders on Yandex Lavka, with their positions and totals.
 * Lavka's own history: it has the courier's details, which are not returned.
 */
export const lavkaOrdersOperation = defineYandexOperation({
  about:
    "The person's latest grocery orders on Yandex Lavka, with their items and totals. Argument: limit (1-20, default 10). Courier details and the delivery address are not returned.",
  access: "read",
  args: z.object({
    limit: z.number().int().min(1).max(20).default(10),
  }),
  id: "food.lavka_orders",
  origin: "https://lavka.yandex.ru/",
  result: z.object({ isEnd: z.boolean(), orders: z.array(lavkaOrder) }),
  run: `async function (args) {
  const page = window.__PAGE_PROPS__;
  const headers = {
    "X-Csrf-Token-Bff": page.csrfToken,
    "X-Lavka-Web-City": String(page.pageEnv.cityId),
    "X-Lavka-Web-Locale": "ru-RU",
    "X-Requested-With": "XMLHttpRequest",
    "X-Grocery-Trusted-User": "true",
    "X-Captcha-Service": "lavka",
    "X-Captcha-Language": "ru",
  };
  const response = await fetch("/api/v1/orders/v1/history/list?count=" + args.limit, { headers });
  if (response.status === 401) return { status: "signed_out" };
  if (response.status >= 400 && /html/.test(response.headers.get("content-type") || "")) return { status: "captcha" };
  if (response.status !== 200) throw new Error("http " + response.status);
  const body = await response.json();
  const orders = body.data.orders.slice(0, args.limit).map((order) => ({
    orderNr: order.deliveryInfo.orderId,
    shortId: order.deliveryInfo.shortOrderId,
    date: order.deliveryInfo.createdAt,
    status: order.deliveryInfo.status,
    canceled: !!(order.deliveryInfo.isCanceled || order.deliveryInfo.isFailed),
    total: Number(order.calculation.finalCost),
    delivery: Number(order.calculation.deliveryCost),
    items: order.positions.slice(0, 6).map((position) => ({
      name: position.title,
      qty: position.count,
      price: Number(position.totalPrice),
    })),
    itemsTotal: order.positions.length,
  }));
  return { status: "ok", data: { orders, isEnd: body.data.isEnd } };
}`,
  service: "yandex-lavka",
});

/**
 * The active grocery orders on Lavka. Only their number is returned: the
 * shape of an active order is not known yet, so nothing of it is passed on.
 */
export const lavkaActiveOperation = defineYandexOperation({
  about:
    "How many grocery orders on Yandex Lavka are active now (not yet delivered or cancelled). Takes no arguments.",
  access: "read",
  args: z.object({}),
  id: "food.lavka_active",
  origin: "https://lavka.yandex.ru/",
  result: z.object({ activeCount: z.number().int().min(0) }),
  run: `async function () {
  const page = window.__PAGE_PROPS__;
  const headers = {
    "X-Csrf-Token-Bff": page.csrfToken,
    "X-Lavka-Web-City": String(page.pageEnv.cityId),
    "X-Lavka-Web-Locale": "ru-RU",
    "X-Requested-With": "XMLHttpRequest",
    "X-Grocery-Trusted-User": "true",
    "X-Captcha-Service": "lavka",
    "X-Captcha-Language": "ru",
  };
  const response = await fetch(
    "/api/v1/providers/orders-tracking/v1/tracked-orders?devicePixelRatio=1&useCache=true",
    { headers }
  );
  if (response.status === 401) return { status: "signed_out" };
  if (response.status >= 400 && /html/.test(response.headers.get("content-type") || "")) return { status: "captcha" };
  if (response.status !== 200) throw new Error("http " + response.status);
  const list = await response.json();
  if (!Array.isArray(list)) throw new Error("tracked-orders shape");
  return { status: "ok", data: { activeCount: list.length } };
}`,
  service: "yandex-lavka",
});

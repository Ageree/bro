import { z } from "zod";
import { defineYandexOperation } from "../operations";

/**
 * The person's Yandex Eda carts, read only. Only their number comes back:
 * the shape of a cart with items is not checked yet, so nothing of it is
 * passed on.
 */
export const edaCartOperation = defineYandexOperation({
  about:
    "How many carts the person has open on Yandex Eda (one per place). Arguments: lat and lon (the same coordinates as the search). Read only.",
  access: "read",
  args: z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  }),
  id: "food.eda_cart",
  origin: "https://eda.yandex.ru/",
  result: z.object({ carts: z.number().int().min(0) }),
  run: `async function (args) {
  const headers = {
    "Content-Type": "application/json;charset=UTF-8",
    "X-Platform": "desktop_web",
    "X-App-Version": "18.50.1",
    "X-Ya-Coordinates": "latitude=" + args.lat + ",longitude=" + args.lon,
  };
  const query =
    "longitude=" + args.lon + "&latitude=" + args.lat +
    "&screen=catalog&shippingType=delivery&autoTranslate=false" +
    "&plus_subscription_toggle_state=false&combo_subscription_toggle_state=false";
  const response = await fetch("/eats/v1/cart/v2/multi-carts?" + query, {
    method: "POST",
    headers,
    body: JSON.stringify({ need_items_icons: true }),
  });
  if (response.status === 401) return { status: "signed_out" };
  if (response.status >= 400 && /html/.test(response.headers.get("content-type") || "")) return { status: "captcha" };
  if (response.status !== 200) throw new Error("http " + response.status);
  const body = await response.json();
  return { status: "ok", data: { carts: (body.carts || []).length } };
}`,
  service: "yandex-eda",
});

/**
 * The person's Lavka cart, read only: what is in it, its prices and why it
 * cannot be ordered yet, if it cannot.
 */
export const lavkaCartOperation = defineYandexOperation({
  about:
    "The person's Yandex Lavka cart, read only: items, prices, and whether it can be checked out (with the reason if not). Takes no arguments; the delivery address is the one chosen in the Lavka account.",
  access: "read",
  args: z.object({}),
  id: "food.lavka_cart",
  origin: "https://lavka.yandex.ru/",
  result: z.object({
    blocker: z.string().nullable(),
    canCheckout: z.boolean(),
    deliveryCost: z.number(),
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        price: z.number(),
        qty: z.number(),
      })
    ),
    itemsCount: z.number().int().min(0),
    itemsPrice: z.number(),
    total: z.number(),
  }),
  run: `async function () {
  const page = window.__PAGE_PROPS__;
  const startup = window.__REACT_QUERY_STATE__.queries.find(
    (entry) => entry.queryKey[0] === "CommonStartup"
  );
  if (!startup) throw new Error("no address in the page");
  const headers = {
    "Content-Type": "application/json",
    "X-Csrf-Token-Bff": page.csrfToken,
    "X-Lavka-Web-City": String(page.pageEnv.cityId),
    "X-Lavka-Web-Locale": "ru-RU",
    "X-Requested-With": "XMLHttpRequest",
    "X-Grocery-Trusted-User": "true",
    "X-Captcha-Service": "lavka",
    "X-Captcha-Language": "ru",
  };
  const response = await fetch("/api/v1/providers/cart/v1/retrieve", {
    method: "POST",
    headers,
    body: JSON.stringify({
      position: { location: [startup.queryKey[1], startup.queryKey[2]] },
      depotType: "regular",
    }),
  });
  if (response.status === 401) return { status: "signed_out" };
  if (response.status >= 400 && /html/.test(response.headers.get("content-type") || "")) return { status: "captcha" };
  if (response.status !== 200) throw new Error("http " + response.status);
  const cart = await response.json();
  return {
    status: "ok",
    data: {
      itemsCount: cart.totalItemsCount,
      itemsPrice: Number(cart.totalItemsPrice),
      total: Number(cart.totalPriceValue),
      deliveryCost: Number(cart.orderConditions.deliveryCost),
      canCheckout: cart.availableForCheckout === true,
      blocker: cart.checkoutUnavailableReason || null,
      items: (cart.items || []).slice(0, 20).map((item) => ({
        id: item.id,
        name: item.title,
        qty: Number(item.quantity),
        price: Number(item.price),
      })),
    },
  };
}`,
  service: "yandex-lavka",
});

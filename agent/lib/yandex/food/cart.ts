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

const lavkaCart = z.object({
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
});

/** Lavka's cart requests from its own page, and the cart as the model sees it. */
const lavkaCartSource = String.raw`
  const page = window.__PAGE_PROPS__;
  const startup = window.__REACT_QUERY_STATE__.queries.find(
    (entry) => entry.queryKey[0] === "CommonStartup"
  );
  if (!startup) throw new Error("no address in the page");
  const location = [startup.queryKey[1], startup.queryKey[2]];
  const wall = (response) =>
    response.status === 401 ? "signed_out"
      : response.status >= 400 && /html/.test(response.headers.get("content-type") || "") ? "captcha"
      : null;
  const post = async (path, body) => {
    const response = await fetch("/api/v1/providers/cart/v1/" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Csrf-Token-Bff": page.csrfToken,
        "X-Lavka-Web-City": String(page.pageEnv.cityId),
        "X-Lavka-Web-Locale": "ru-RU",
        "X-Requested-With": "XMLHttpRequest",
        "X-Grocery-Trusted-User": "true",
        "X-Captcha-Service": "lavka",
        "X-Captcha-Language": "ru",
      },
      body: JSON.stringify({ ...body, position: { location }, depotType: "regular" }),
    });
    const blocked = wall(response);
    if (blocked) return { blocked };
    if (response.status !== 200) throw new Error("http " + response.status);
    return { cart: await response.json() };
  };
  const summary = (cart) => ({
    itemsCount: cart.totalItemsCount ?? (cart.items || []).length,
    itemsPrice: Number(cart.totalItemsPrice),
    total: Number(cart.totalPriceValue),
    deliveryCost: Number(cart.orderConditions.deliveryCost),
    canCheckout: cart.availableForCheckout === true,
    blocker: cart.checkoutUnavailableReason || null,
    items: (cart.items || []).slice(0, 20).map((item) => ({
      id: item.id,
      // Lavka's titles carry soft hyphens for its own line breaks.
      name: item.title.replaceAll("\u00ad", ""),
      qty: Number(item.quantity),
      price: Number(item.price),
    })),
  });
`;

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
  result: lavkaCart,
  run: `async function () {${lavkaCartSource}
  const read = await post("retrieve", {});
  if (read.blocked) return { status: read.blocked };
  return { status: "ok", data: summary(read.cart) };
}`,
  service: "yandex-lavka",
});

/**
 * Sets how many of each product the person's Lavka cart holds, as the site's
 * own plus and minus do: one update of the current cart version, the other
 * items left as they are. Prices come from food.lavka_search; Lavka checks
 * them and answers with its own.
 */
export const lavkaCartSetOperation = defineYandexOperation({
  about:
    "Set the quantity of products in the person's Yandex Lavka cart (0 removes one; others stay). Arguments: items, each {id, quantity, price} with id and price from food.lavka_search. Answers the cart as food.lavka_cart does.",
  access: "cart",
  args: z.object({
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          price: z.number().nonnegative(),
          quantity: z.number().int().min(0).max(50),
        })
      )
      .min(1)
      .max(20),
  }),
  id: "food.lavka_cart_set",
  origin: "https://lavka.yandex.ru/",
  result: lavkaCart,
  run: `async function (args) {${lavkaCartSource}
  const read = await post("retrieve", {});
  if (read.blocked) return { status: read.blocked };
  const updated = await post("update", {
    items: args.items.map((item) => ({
      id: item.id,
      pricePerCount: "1",
      quantityType: "unit",
      quantity: String(item.quantity),
      price: String(item.price),
      title: "",
      currency: "RUB",
    })),
    deliveryType: read.cart.deliveryType,
    deliveryTimeInfo: read.cart.deliveryTimeInfo,
    cartId: read.cart.cartId,
    cartVersion: read.cart.cartVersion,
    idempotencyToken: read.cart.nextIdempotencyToken || crypto.randomUUID(),
  });
  if (updated.blocked) return { status: updated.blocked };
  return { status: "ok", data: summary(updated.cart) };
}`,
  service: "yandex-lavka",
});

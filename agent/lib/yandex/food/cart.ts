import { lavkaPageSource } from "./lavka-page";
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
  origin: "https://eda.yandex.ru/robots.txt",
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

const edaCart = z.object({
  deliveryFee: z.number(),
  items: z.array(
    z.object({
      itemId: z.number().int(),
      name: z.string(),
      price: z.number(),
      quantity: z.number().int().min(1),
    })
  ),
  subtotal: z.number(),
  total: z.number(),
});

/**
 * Sets how many of each dish the person's Yandex Eda cart holds from one
 * restaurant, as the site does: a change of a dish already in the cart is one
 * PUT of its absolute quantity (add_bulk would add to it), 0 deletes it, and a
 * new dish is one add_bulk. Restaurants only: the slug is one of
 * food.eda_search's or food.eda_menu's.
 */
export const edaCartSetOperation = defineYandexOperation({
  about:
    "Set how many of each dish the person's Yandex Eda cart holds from one restaurant (0 removes it; other dishes stay). Arguments: lat and lon (the delivery coordinates), place (the restaurant's slug from food.eda_search or food.eda_menu), items: each {id, quantity} with the dish id from food.eda_menu. Answers the cart: items with prices, delivery fee, subtotal and total.",
  access: "cart",
  args: z.object({
    items: z
      .array(
        z.object({
          id: z.number().int().positive(),
          quantity: z.number().int().min(0).max(50),
        })
      )
      .min(1)
      .max(20),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    place: z.string().min(1).max(200),
  }),
  id: "food.eda_cart_set",
  origin: "https://eda.yandex.ru/",
  result: edaCart,
  run: `async function (args) {
  const headers = {
    "Content-Type": "application/json;charset=UTF-8",
    "X-Platform": "desktop_web",
    "X-App-Version": "18.50.1",
    "X-Ya-Coordinates": "latitude=" + args.lat + ",longitude=" + args.lon,
  };
  // soft_multi is what makes the site's cart of this place visible to reads.
  const query =
    "latitude=" + args.lat + "&longitude=" + args.lon +
    "&shippingType=delivery&screen=menu&autoTranslate=false&soft_multi=true" +
    "&placeSlug=" + encodeURIComponent(args.place);
  const send = async (method, url, body) => {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) return { blocked: "signed_out" };
    if (response.status >= 400 && /html/.test(response.headers.get("content-type") || "")) return { blocked: "captcha" };
    if (response.status !== 200) throw new Error("http " + response.status);
    return { cart: (await response.json()).cart };
  };
  const read = await send("POST", "/eats/v1/cart/v2/full-carts?" + query + "&plus_subscription_toggle_state=false&combo_subscription_toggle_state=false", {});
  if (read.blocked) return { status: read.blocked };
  let cart = read.cart;
  for (const wanted of args.items) {
    const current = (cart.items || []).find((item) => item.item_id === wanted.id);
    let change = null;
    if (current && wanted.quantity === 0) {
      change = await send("DELETE", "/api/v1/cart/" + current.id + "?" + query);
    } else if (current && wanted.quantity !== current.quantity) {
      change = await send("PUT", "/api/v1/cart/" + current.id + "?" + query, { quantity: wanted.quantity, itemOptions: [] });
    } else if (!current && wanted.quantity > 0) {
      change = await send("POST", "/api/v1/cart/add_bulk?" + query, {
        items: [{ item_id: wanted.id, quantity: wanted.quantity }],
        place_slug: args.place,
        place_business: "restaurant",
      });
    }
    if (change && change.blocked) return { status: change.blocked };
    if (change) cart = change.cart;
  }
  return {
    status: "ok",
    data: {
      deliveryFee: Number(cart.decimal_delivery_fee),
      items: (cart.items || []).slice(0, 30).map((item) => ({
        itemId: item.item_id,
        name: item.name.trim(),
        price: item.price,
        quantity: item.quantity,
      })),
      subtotal: Number(cart.decimal_subtotal),
      total: Number(cart.decimal_total),
    },
  };
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
  discount: z.number(),
  itemsCount: z.number().int().min(0),
  itemsPrice: z.number(),
  total: z.number(),
});

/** Lavka's cart requests from its own page, and the cart as the model sees it. */
const lavkaCartSource = String.raw`
  ${lavkaPageSource}
  const state = await lavkaPage();
  if (state === null) return { status: "captcha" };
  const page = state.page;
  const startup = state.queries.find(
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
    // Before the menu discount; the items' own prices carry it.
    itemsPrice: Number(cart.totalItemsPrice),
    discount: Number(cart.totalDiscountValue ?? 0),
    total: Number(cart.totalPriceValue),
    deliveryCost: Number(cart.orderConditions.deliveryCost),
    canCheckout: cart.availableForCheckout === true,
    blocker: cart.checkoutUnavailableReason || null,
    items: (cart.items || []).slice(0, 20).map((item) => ({
      id: item.id,
      // Lavka's titles carry soft hyphens for its own line breaks and
      // <notr> marks for its translations.
      name: item.title.replaceAll("\u00ad", "").replace(/<\/?notr>/g, ""),
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
  origin: "https://lavka.yandex.ru/robots.txt",
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

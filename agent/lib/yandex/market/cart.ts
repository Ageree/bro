import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { buyOptionSource, marketCardUrl } from "./product";
import { marketRun } from "./prologue";

/**
 * The page's cart model (offer id → cart item id and count), cut out of the
 * page state as plain JSON. Source for the bodies that change or show the
 * cart; they define `html` first.
 */
const cartModelSource = String.raw`let model = {};
const at = html.indexOf('"cartModel":{');
if (at >= 0) {
  let depth = 0,
    end = -1;
  for (let i = at + 12; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  try {
    model = JSON.parse(html.slice(at + 12, end)).items || {};
  } catch (e) {}
}`;

const offerId = z.string().regex(/^[\w-]{10,40}$/u);

/**
 * The cart's change is one call of Market's cart API from the cart page; the
 * same answer carries the whole cart. Only the request and its answer are
 * read: the cart's own change-form and checkout stay with browser_task.
 */
const cartChangeHeaders = {
  "content-type": "application/json",
  "x-market-apphost-target": "ACTUALIZER",
  "x-market-page-id": "market:cart",
  "x-market-core-service": "mf-search-desktop",
  "x-requested-with": "XMLHttpRequest",
};

const cartPositionsSchema = z.number().int().nullable();

export const marketCartOperation = defineYandexOperation({
  about:
    "Reads the person's Yandex Market cart: each position with its offer id, title, count, price (and the price with the Yandex Pay card), availability and delivery text, and the totals. Takes no arguments.",
  access: "read",
  args: z.object({}),
  id: "market.cart",
  origin: "https://market.yandex.ru/",
  result: z.object({
    count: z.number().int(),
    items: z.array(
      z.object({
        available: z.boolean(),
        count: z.number().int().nullable(),
        delivery: z.string().nullable(),
        maxCount: z.number().int().nullable(),
        offerId: z.string(),
        oldPrice: z.number().nullable(),
        price: z.number().nullable(),
        priceCard: z.number().nullable(),
        title: z.string().nullable(),
      })
    ),
    total: z.object({
      line: z.string().nullable(),
      withCard: z.number().nullable(),
      withoutCard: z.number().nullable(),
    }),
  }),
  run: marketRun(String.raw`const pg = await getPage("/my/cart");
if (pg.error) return pg.error;
const { doc, html } = pg;
${cartModelSource}
const txt = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : null);
const money = (s) => {
  const m = s && s.match(/(\d[\d ]*)\s*₽/);
  return m ? Number(m[1].replace(/\s/g, "")) : null;
};
const items = [];
doc.querySelectorAll('[data-zone-name="productSnippet"]').forEach((s) => {
  let zd;
  try {
    zd = JSON.parse(s.getAttribute("data-zone-data"));
  } catch (e) {
    return;
  }
  if (!zd || zd.type !== "offer") return;
  const m = model[zd.wareId] || {};
  const card = (zd.loyaltyPrices || []).find((p) => p.priceType === "yaBank");
  const disc = (zd.loyaltyPrices || []).find((p) => p.priceType === "withDiscount");
  items.push({
    offerId: zd.wareId,
    title: txt(s.querySelector('[data-auto="snippet-title"]')),
    count: m.count || zd.itemsCount || null,
    maxCount: zd.maxQuantity || null,
    available: zd.isAvailable !== false,
    price: disc
      ? disc.priceValue
      : money(txt(s.querySelector('[data-auto="snippet-price-current"]'))),
    priceCard: card ? card.priceValue : null,
    oldPrice: zd.price && disc && zd.price > disc.priceValue ? zd.price : null,
    delivery: txt(s.querySelector('[data-auto="delivery-wrapper"]')),
  });
});
return ok({
  count: items.length,
  items,
  total: {
    withCard: money(txt(doc.querySelector('[data-auto="total-price"]'))),
    withoutCard: money(txt(doc.querySelector('[data-auto="total-price-without-card"]'))),
    line: txt(doc.querySelector('[data-auto="item-summary-info"]')),
  },
});`),
  service: "market",
});

export const marketCartAddOperation = defineYandexOperation({
  about:
    "Adds one Yandex Market card to the person's cart, one unit. Change the cart only when the person asked for it in their own words; checkout and payment are never done here, they are browser_task. Argument: url, the card's url from market.search or market.product.",
  access: "cart",
  args: z.object({ url: marketCardUrl }),
  id: "market.cart_add",
  origin: "https://market.yandex.ru/",
  result: z.object({
    cartItemId: z.string().nullable(),
    cartPositions: cartPositionsSchema,
    count: z.number().int().nullable(),
    offerId: z.string(),
    title: z.string().nullable(),
  }),
  run: marketRun(String.raw`const path = args.url.replace(/^https:\/\/market\.yandex\.ru/, "");
if (!/^\/card\/[^/?#]+\/\d+/.test(path))
  return fail("bad_argument", "url must look like /card/<slug>/<sku>?do-waremd5=<offerId>");
const pg = await getPage(path);
if (pg.error) return pg.error;
const doc = pg.doc;
${buyOptionSource}
if (!buy || !buy.offerId || !buy.feeShow)
  return fail("not_found", "no buyOption with feeShow on the card page");
const sk = await getSk();
if (!sk) return fail("not_signed_in", "no sk");
await sleep(1100);
const r = await fetch(
  "/api/web/market.front.purchaseCore.PurchaseCore/prepareCartModelAddItems",
  {
    method: "POST",
    credentials: "include",
    headers: { ...${JSON.stringify(cartChangeHeaders)}, sk },
    body: JSON.stringify({
      path: "/my/cart",
      params: {
        items: [{ offerId: buy.offerId, feeShow: buy.feeShow }],
        settings: { buttonType: "FLAT", isSins: false, isSeparatedDomainSins: false },
      },
    }),
  }
);
if (/showcaptcha|captcha/.test(r.url) || r.status === 429)
  return fail("captcha", "cart add");
const j = await r.json();
const cm = j.result && j.result.collections && j.result.collections.cartModel;
if (!cm)
  return fail("add_failed", "status " + r.status + " " + JSON.stringify(j.error || j).slice(0, 200));
const mine = cm.items[buy.offerId];
return ok({
  offerId: buy.offerId,
  title: buy.title || null,
  count: mine ? mine.count : null,
  cartItemId: mine ? mine.cartItemId : null,
  cartPositions: cm.carts.market ? cm.carts.market.count : null,
});`),
  service: "market",
});

export const marketCartRemoveOperation = defineYandexOperation({
  about:
    "Removes one offer from the person's Yandex Market cart, the whole position. Change the cart only when the person asked for it in their own words. Argument: offerId, from market.cart. An offer that is not in the cart answers count 0 with cartPositions null.",
  access: "cart",
  args: z.object({ offerId }),
  id: "market.cart_remove",
  origin: "https://market.yandex.ru/",
  result: z.object({
    cartPositions: cartPositionsSchema,
    count: z.number().int(),
    offerId: z.string(),
  }),
  run: marketRun(String.raw`const pg = await getPage("/my/cart");
if (pg.error) return pg.error;
const { html } = pg;
${cartModelSource}
const it = model[args.offerId];
if (!it) return ok({ offerId: args.offerId, count: 0, cartPositions: null });
const sk = await getSk();
if (!sk) return fail("not_signed_in", "no sk");
await sleep(1100);
const r = await fetch(
  "/api/web/market.front.purchaseCore.PurchaseCore/prepareCartModelChangeAmount",
  {
    method: "POST",
    credentials: "include",
    headers: { ...${JSON.stringify(cartChangeHeaders)}, sk },
    body: JSON.stringify({
      path: "/my/cart",
      params: {
        items: [{ offerId: it.offerId, cartItemId: it.cartItemId, count: 0 }],
      },
    }),
  }
);
if (/showcaptcha|captcha/.test(r.url) || r.status === 429)
  return fail("captcha", "cart change");
const j = await r.json();
const cm = j.result && j.result.collections && j.result.collections.cartModel;
if (!cm)
  return fail("change_failed", "status " + r.status + " " + JSON.stringify(j.error || j).slice(0, 200));
const left = cm.items[args.offerId];
return ok({
  offerId: args.offerId,
  count: left ? left.count : 0,
  cartPositions: cm.carts.market ? cm.carts.market.count : 0,
});`),
  service: "market",
});

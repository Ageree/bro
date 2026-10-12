import { z } from "zod";
import { purchaseQuoteSchema } from "../lavka/checkout";
import { type JsonValue, defineYandexOperation } from "../operations";
import { runYandexOperation } from "../transport";

const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Where an Eda order goes: one restaurant's cart, to a saved address. */
const targetSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  place: z.string().min(1).max(200),
});

const snapshotSchema = targetSchema.extend({
  addressId: z.string().min(1),
  addressVersion: z.number().int().nonnegative(),
  amountMinor: minor,
  cardId: z.string().regex(/^card-/u),
  expiresAt: z.iso.datetime(),
  items: z
    .array(
      z.strictObject({
        id: z.number().int(),
        priceMinor: minor,
        quantity: z.number().int().positive(),
      })
    )
    .min(1),
});

const prepareResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blocked"), reason: z.string() }),
  z.object({
    checkoutKey: z.string().min(1),
    expiresAt: z.iso.datetime(),
    kind: z.literal("ready"),
    publicQuote: purchaseQuoteSchema,
    snapshot: snapshotSchema,
  }),
]);

const paymentSchema = z.object({
  confirmUrl: z.url().optional(),
  paymentStatus: z.enum(["paid", "needs_confirmation", "failed", "pending"]),
});

const submitResultSchema = z.discriminatedUnion("kind", [
  paymentSchema.extend({
    kind: z.literal("placed"),
    orderId: z.string().min(1),
  }),
  z.object({ kind: z.literal("rejected"), reason: z.string() }),
  z.object({ kind: z.literal("unknown") }),
]);

/**
 * The site's own requests. Eda refuses an order without a client device id
 * («UserData»); it is the client's own random id, not read from a cookie.
 */
const pageSource = String.raw`
  const ok = (data) => ({ status: "ok", data });
  const block = (reason) => { throw Object.assign(new Error("checkout blocked"), { reason }); };
  const money = (value) => {
    const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(String(value ?? ""));
    if (!match) block("money_invalid");
    return Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  };
  const request = async (method, path, body, beforeSend) => {
    const options = {
      method,
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "X-Platform": "desktop_web",
        "X-App-Version": "18.50.1",
        "X-Ya-Coordinates": "latitude=" + args.lat + ",longitude=" + args.lon,
        "X-Taxi": navigator.userAgent + " platform=eats_desktop_web",
        "X-Device-Id": crypto.randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    };
    beforeSend?.();
    const response = await fetch(path, options);
    if (response.status === 401) block("signed_out");
    if (response.status >= 400 && /html/.test(response.headers.get("content-type") || "")) block("captcha");
    const data = await response.json().catch(() => null);
    if (response.status !== 200) block(typeof data?.code === "number" ? "eda_" + data.code : "http_error");
    return data;
  };
  const query = "latitude=" + args.lat + "&longitude=" + args.lon +
    "&shippingType=delivery&screen=checkout&autoTranslate=false&soft_multi=true&placeSlug=" + encodeURIComponent(args.place);
  const readCheckout = async () => {
    const cart = (await request("POST", "/eats/v1/cart/v2/full-carts?" + query +
      "&plus_subscription_toggle_state=false&combo_subscription_toggle_state=false", {}))?.cart;
    const lines = cart?.items || [];
    if (lines.length === 0) block("empty_cart");
    const items = lines.map((line) => {
      if (!Number.isInteger(line.item_id) || !Number.isInteger(line.quantity) || line.quantity < 1 || typeof line.name !== "string") block("cart_invalid");
      return { id: line.item_id, priceMinor: money(line.price), quantity: line.quantity, title: line.name.trim() };
    });
    const homes = (await request("GET", "/api/v3/user/addresses")).filter((a) =>
      Math.abs(a.location?.latitude - args.lat) < 1e-5 && Math.abs(a.location?.longitude - args.lon) < 1e-5);
    if (homes.length !== 1) block(homes.length ? "address_ambiguous" : "saved_address_required");
    const home = homes[0];
    const address = { city: home.city, street: home.street || "", house: home.house, entrance: home.entrance, doorcode: home.doorcode,
      floor: home.floor, office: home.office, comment: home.comment, uri: home.uri, country: home.country, shortText: home.short_text,
      fullText: home.full_text, location: home.location, areas: [], districts: home.districts || [] };
    const checkout = await request("POST", "/api/v2/cart/go-checkout?longitude=" + args.lon + "&latitude=" + args.lat,
      { address, place_slug: args.place, payment: { recently_link_cards: false } });
    if ((checkout.unavailable_items_for_delivery || []).length) block("item_unavailable");
    // The first is the card the person paid with last, as the site preselects it.
    const offer = (checkout.offers || []).find((o) => o.mappingType === "base" && o.availability?.available &&
      o.possiblePayment?.availability?.available && /^card-/.test(o.possiblePayment.id || ""));
    if (!offer) block("payment_unverified");
    const amountMinor = money(offer.possiblePayment.costForCustomer?.value);
    if (amountMinor !== money(cart.decimal_total)) block("money_inconsistent");
    const snapshot = { addressId: home.id, addressVersion: home.version, amountMinor, cardId: offer.possiblePayment.id,
      items: items.map(({ id, priceMinor, quantity }) => ({ id, priceMinor, quantity })), lat: args.lat, lon: args.lon, place: args.place };
    const publicQuote = { amountMinor, currency: "RUB",
      delivery: [home.short_text, home.office ? "кв. " + home.office : null].filter(Boolean).join(", "),
      items: items.map(({ title, quantity }) => ({ title, quantity: String(quantity) })),
      payment: "Карта " + offer.possiblePayment.title };
    return { address, home, offer, phone: checkout.meta?.phone, publicQuote, snapshot };
  };
  // The site's PaymentTracking: done is paid, 3ds_required waits for the bank form.
  const payment = async (orderId, waitMs) => {
    const until = Date.now() + waitMs;
    for (;;) {
      let state = null;
      try { state = (await request("POST", "/eats/v1/eats-payments/v1/order/tracking", { order_id: orderId }))?.order?.payment; } catch {}
      const url = state?.payload?.url;
      if (state?.status === "done") return { paymentStatus: "paid" };
      if (state?.status === "error" || state?.status === "cancelled" || state?.error_message) return { paymentStatus: "failed" };
      if (state?.status === "3ds_required" && typeof url === "string" && /^https:\/\//.test(url)) return { paymentStatus: "needs_confirmation", confirmUrl: url };
      if (Date.now() + 2000 > until) return { paymentStatus: "pending" };
      await new Promise((done) => setTimeout(done, 2000));
    }
  };
  const errorAnswer = (error, kind) => {
    const reason = typeof error?.reason === "string" ? error.reason : "unavailable";
    if (reason === "signed_out" || reason === "captcha") return { status: reason };
    return ok({ kind, reason });
  };
`;

const prepareOperation = defineYandexOperation({
  about:
    "Reads one Eda restaurant cart as an exact order to a saved address with the card Eda offers.",
  access: "read",
  args: targetSchema,
  id: "eda.purchase_prepare",
  origin: "https://eda.yandex.ru/",
  result: prepareResultSchema,
  run: `async function (args) {${pageSource}
    try {
      const { publicQuote, snapshot } = await readCheckout();
      const expiresAt = new Date(Date.now() + 120000).toISOString();
      return ok({ kind: "ready", checkoutKey: args.place + ":" + snapshot.addressId, expiresAt, publicQuote, snapshot: { ...snapshot, expiresAt } });
    } catch (error) { return errorAnswer(error, "blocked"); }
  }`,
  service: "yandex-eda",
});

const submitOperation = defineYandexOperation({
  about:
    "Places one confirmed Eda order after a fresh exact comparison, without retries.",
  access: "purchase",
  args: z.object({ amountMinor: minor, snapshot: snapshotSchema }),
  id: "eda.purchase_submit",
  origin: "https://eda.yandex.ru/",
  result: submitResultSchema,
  run: `async function (input) {
    const args = input.snapshot;${pageSource}
    let sent = false;
    try {
      const approved = input.snapshot;
      if (approved.amountMinor !== input.amountMinor) block("amount_changed");
      if (Date.parse(approved.expiresAt) <= Date.now()) block("quote_expired");
      const current = await readCheckout();
      for (const key of Object.keys(current.snapshot)) {
        if (JSON.stringify(current.snapshot[key]) !== JSON.stringify(approved[key])) block(key === "amountMinor" ? "amount_changed" : "checkout_changed");
      }
      // request_id names the offer just read: Eda takes the price it showed
      // only with it, and refuses another as «the delivery got dearer».
      const answer = await request("POST", "/api/v1/orders", { paymentMethodId: approved.cardId, phone: current.phone, personsQuantity: 1,
        courierOptions: [], extendedOptions: [], payment: { recently_link_cards: false }, place_slug: approved.place,
        address: current.address, userAddressId: approved.addressId, plus_subscription_toggle_state: false,
        request_id: current.offer.requestId }, () => { sent = true; });
      if (typeof answer?.order_nr !== "string" || !answer.order_nr) return ok({ kind: "unknown" });
      return ok({ kind: "placed", orderId: answer.order_nr, ...await payment(answer.order_nr, 15000) });
    } catch (error) {
      // Eda's own refusal (a 4xx with its code) placed nothing; anything else after sending may have.
      if (sent && !/^eda_/.test(error?.reason || "")) return ok({ kind: "unknown" });
      return errorAnswer(error, "rejected");
    }
  }`,
  service: "yandex-eda",
});

const paymentOperation = defineYandexOperation({
  about:
    "Reads where the card payment of one placed Eda order stands, without paying or cancelling anything.",
  access: "read",
  args: targetSchema.pick({ lat: true, lon: true }).extend({
    orderId: z.string().min(1).max(100),
  }),
  id: "eda.purchase_payment",
  origin: "https://eda.yandex.ru/",
  result: paymentSchema,
  run: `async function (args) {${pageSource}
    return ok(await payment(args.orderId, 0));
  }`,
  service: "yandex-eda",
});

/** Where an approved Eda quote goes, to read it again when it expired. */
export function edaTarget(snapshot: JsonValue) {
  return targetSchema.safeParse(snapshot).data;
}

export async function prepareEdaPurchase(
  workspaceId: string,
  target: z.output<typeof targetSchema>,
  approvedSnapshot?: JsonValue
): Promise<z.output<typeof prepareResultSchema>> {
  const outcome = await runYandexOperation(
    workspaceId,
    prepareOperation,
    target
  );
  if (outcome.kind !== "ok") return { kind: "blocked", reason: outcome.kind };
  const result = prepareResultSchema.safeParse(outcome.data);
  if (!result.success) return { kind: "blocked", reason: "response_invalid" };
  if (approvedSnapshot !== undefined && result.data.kind === "ready") {
    const terms = snapshotSchema.omit({ expiresAt: true });
    const approved = terms.safeParse(approvedSnapshot);
    if (
      !approved.success ||
      JSON.stringify(approved.data) !==
        JSON.stringify(terms.parse(result.data.snapshot))
    )
      return { kind: "blocked", reason: "checkout_changed" };
  }
  return result.data;
}

export async function submitEdaPurchase(
  workspaceId: string,
  input: { readonly amountMinor: number; readonly snapshot: JsonValue }
): Promise<z.output<typeof submitResultSchema>> {
  const parsed = submitOperation.args.safeParse(input);
  if (!parsed.success) return { kind: "rejected", reason: "snapshot_invalid" };
  const outcome = await runYandexOperation(
    workspaceId,
    submitOperation,
    parsed.data
  );
  if (outcome.kind === "signed_out" || outcome.kind === "captcha")
    return { kind: "rejected", reason: outcome.kind };
  if (outcome.kind !== "ok") return { kind: "unknown" };
  const result = submitResultSchema.safeParse(outcome.data);
  return result.success ? result.data : { kind: "unknown" };
}

/** The payment of a placed order now; `pending` when it cannot be read. */
export async function readEdaPayment(
  workspaceId: string,
  snapshot: JsonValue,
  orderId: string
) {
  const target = edaTarget(snapshot);
  if (!target) return { paymentStatus: "pending" as const };
  const outcome = await runYandexOperation(workspaceId, paymentOperation, {
    lat: target.lat,
    lon: target.lon,
    orderId,
  });
  const result =
    outcome.kind === "ok" ? paymentSchema.safeParse(outcome.data) : undefined;
  return result?.success ? result.data : { paymentStatus: "pending" as const };
}

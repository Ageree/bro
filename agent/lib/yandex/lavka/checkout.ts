import { z } from "zod";
import { type JsonValue, defineYandexOperation } from "../operations";
import { runYandexOperation } from "../transport";

const minorAmountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const lavkaPublicQuoteSchema = z.object({
  amountMinor: minorAmountSchema,
  currency: z.literal("RUB"),
  delivery: z.string().min(1),
  items: z
    .array(z.object({ quantity: z.string().min(1), title: z.string().min(1) }))
    .min(1),
  payment: z.string().min(1),
});

const snapshotSchema = z.strictObject({
  addressHash: z.string().regex(/^[a-f0-9]{64}$/u),
  addressId: z.string().min(1),
  addressVersion: z.number().int().nonnegative(),
  amountMinor: minorAmountSchema,
  cartId: z.string().min(1),
  cartVersion: z.number().int().positive(),
  deliveryConditionsId: z.string().min(1),
  deliveryMinor: minorAmountSchema,
  deliveryType: z.literal("eats_dispatch"),
  expiresAt: z.iso.datetime(),
  flowVersion: z.literal("grocery_flow_v1"),
  items: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        positionId: z.string().min(1),
        quantity: z.string().regex(/^[1-9]\d*$/u),
        title: z.string().min(1),
        unitPriceMinor: minorAmountSchema,
      })
    )
    .min(1),
  itemsMinor: minorAmountSchema,
  offerId: z.string().min(1),
  payment: z.strictObject({
    currency: z.literal("RUB"),
    id: z.string().min(1),
    last4: z
      .string()
      .regex(/^\d{4}$/u)
      .nullable(),
    source: z.literal("diehard"),
    system: z.enum(["VISA", "MasterCard", "MASTERCARD", "MIR"]),
    type: z.literal("card"),
    verifyStrategy: z.literal("card_antifraud"),
  }),
  validUntil: z.iso.datetime({ offset: true }),
  version: z.literal(1),
});

const prepareResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blocked"), reason: z.string() }),
  z.object({
    checkoutKey: z.string().min(1),
    expiresAt: z.iso.datetime(),
    kind: z.literal("ready"),
    publicQuote: lavkaPublicQuoteSchema,
    snapshot: snapshotSchema,
  }),
]);

const submitResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("placed"),
    orderId: z.string().min(1),
    paymentStatus: z.literal("unknown"),
  }),
  z.object({ kind: z.literal("rejected"), reason: z.string() }),
  z.object({ kind: z.literal("unknown") }),
]);

const pageSource = String.raw`
  const ok = (data) => ({ status: "ok", data });
  const block = (reason) => { throw Object.assign(new Error("checkout blocked"), { reason }); };
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value, reason) => typeof value === "string" && value.length > 0 ? value : block(reason);
  const money = (value) => {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.test(value)) block("money_invalid");
    const [whole, fraction = ""] = value.split(".");
    const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (minor > BigInt(Number.MAX_SAFE_INTEGER)) block("money_invalid");
    return Number(minor);
  };
  const hash = async (value) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const request = async (path, body, beforeSend) => {
    await new Promise((done) => setTimeout(done, 1100));
    const page = window.__PAGE_PROPS__;
    if (!page?.csrfToken || !page?.pageEnv) block("page_unavailable");
    const options = {
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
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    };
    beforeSend?.();
    const response = await fetch(path, options);
    if (response.status === 401) block("signed_out");
    if (response.headers.get("x-yandex-captcha") === "captcha" ||
        response.status >= 400 && /html/.test(response.headers.get("content-type") || "")) block("captcha");
    if (response.status !== 200) block("http_error");
    const data = await response.json();
    if (!record(data)) block("response_invalid");
    return data;
  };
  const savedAddress = () => {
    const queries = window.__REACT_QUERY_STATE__?.queries;
    if (!Array.isArray(queries)) block("page_unavailable");
    const startup = queries.find((entry) => entry.queryKey?.[0] === "CommonStartup");
    const location = startup?.queryKey?.slice(1, 3);
    if (!location || location.length !== 2 || !location.every(Number.isFinite) || startup.state?.data?.currency !== "RUB") block("address_unavailable");
    const saved = queries.find((entry) => entry.queryKey?.[0] === "FavoriteAddresses")?.state?.data;
    const matches = Array.isArray(saved) ? saved.filter((entry) => JSON.stringify(entry.address?.location) === JSON.stringify(location)) : [];
    if (matches.length > 1) block("address_ambiguous");
    const selected = matches[0];
    if (!selected || !Number.isSafeInteger(selected.addressVersion) || selected.addressVersion < 0) block("saved_address_required");
    text(selected.addressId, "saved_address_required");
    const a = selected.address;
    for (const key of ["country", "city", "street", "house"]) text(a[key], "address_unavailable");
    const position = { location, placeId: a.placeId || "", country: a.country, city: a.city, street: a.street, house: a.house };
    for (const key of ["floor", "flat", "comment", "entrance", "doorcode", "buildingName", "doorbellName", "leftAtDoor", "meetOutside", "noDoorCall"]) {
      const value = a[key];
      if (value !== undefined) {
        if (typeof value !== "string" && typeof value !== "boolean") block("address_unavailable");
        position[key] = value;
      }
    }
    if (a.doorcodeExtra || a.companyName || a.buildingType) block("address_unsupported");
    return { selected, position, countryIso3: text(startup.state.data.countryIso3, "address_unavailable"), currency: startup.state.data.currency };
  };
  const validateCart = (cart) => {
    if (!Array.isArray(cart.items) || cart.items.length === 0) block("empty_cart");
    if (cart.items.length > 100 || cart.availableForCheckout !== true || cart.checkoutUnavailableReason) block("cart_unavailable");
    if (cart.orderFlowVersion !== "grocery_flow_v1" || cart.deliveryType !== "eats_dispatch" ||
        cart.deliveryTimeInfo?.kind !== "on_demand" || cart.deliveryTimeInfo?.tariff !== "default" ||
        cart.logisticMethod !== "onDemand" || cart.secondaryPaymentMethod || cart.timeslot || cart.loyalty ||
        cart.cashback?.flow || cart.promocode ||
        cart.tips && money(cart.tips.amount) !== 0 || cart.charity || cart.subscription || cart.subscriptions ||
        cart.statuses?.hasWeighedItems || cart.statuses?.hasRetailItems || cart.statuses?.hasPackages ||
        cart.statuses?.hasRestrictionsItems || cart.statuses?.isRover || cart.statuses?.isDrone || cart.statuses?.isPickup) block("cart_unsupported");
    text(cart.cartId, "cart_invalid");
    text(cart.offerId, "cart_invalid");
    text(cart.deliveryConditionsId, "cart_invalid");
    if (!Number.isSafeInteger(cart.cartVersion) || cart.cartVersion <= 0 || !Number.isFinite(Date.parse(cart.validUntil)) || Date.parse(cart.validUntil) <= Date.now()) block("quote_expired");
    const items = cart.items.map((item) => {
      if (item.currency !== "RUB" || item.quantityType !== "unit" || item.isUnavailableOnDepot ||
          item.isFromExtraDepot || item.adult || item.docsRequired || item.isPackage || item.isReturnParcel || item.isGoalReward ||
          !Array.isArray(item.restrictions) || item.restrictions.length || !Array.isArray(item.modifiers) || item.modifiers.length ||
          typeof item.quantity !== "string" || !/^[1-9]\d*$/.test(item.quantity) || !Number.isSafeInteger(Number(item.quantity))) block("item_unsupported");
      return { id: text(item.id, "cart_invalid"), positionId: text(item.positionId, "cart_invalid"), quantity: item.quantity,
        title: text(item.title, "cart_invalid"), unitPriceMinor: money(item.price) };
    }).sort((a, b) => a.positionId.localeCompare(b.positionId));
    const amountMinor = money(cart.totalPriceValue);
    const itemsMinor = money(cart.totalItemsPrice);
    const deliveryMinor = money(cart.orderConditions?.deliveryCost);
    const sum = items.reduce((total, item) => total + BigInt(item.unitPriceMinor) * BigInt(item.quantity), 0n);
    const serviceFees = money(cart.paidServices?.totalServiceFees?.amount);
    const retailFee = money(cart.paidServices?.retailServiceFee?.amount);
    if (serviceFees !== 0 || retailFee !== 0 || cart.serviceFee && money(cart.serviceFee.amount) !== 0 || cart.bagsFee && money(cart.bagsFee.amount) !== 0) block("fees_unsupported");
    if (sum !== BigInt(itemsMinor) || BigInt(itemsMinor) + BigInt(deliveryMinor) !== BigInt(amountMinor)) block("money_inconsistent");
    return { amountMinor, itemsMinor, deliveryMinor, items };
  };
  const cardShape = (method) => {
    if (!record(method) || method.type !== "card" || method.currency !== "RUB" || method.availability?.available !== true ||
        method.source !== "diehard" || method.verifyStrategy !== "card_antifraud" ||
        !["VISA", "MasterCard", "MASTERCARD", "MIR"].includes(method.system) || method.isYandexCard || method.meta || method.overspending) block("payment_unsupported");
    const last4 = typeof method.number === "string" ? /^[*•xX\s-]*(\d{4})$/.exec(method.number.trim())?.[1] || null : null;
    return { currency: method.currency, id: text(method.id, "payment_unverified"), last4, source: method.source,
      system: method.system, type: method.type, verifyStrategy: method.verifyStrategy };
  };
  const readCheckout = async () => {
    const address = savedAddress();
    const cart = await request("/api/v1/providers/cart/v1/retrieve", { position: { location: address.position.location }, depotType: "regular" });
    const amounts = validateCart(cart);
    const layout = await request("/api/v1/providers/orders/v1/checkout-layout", { location: address.position.location, countryIso3: address.countryIso3 });
    if (!Array.isArray(layout.checkoutLayout?.layoutItems)) block("checkout_unverified");
    for (const field of layout.checkoutLayout.layoutItems) {
      if (field.isRequired && !address.position[field.name]) block("address_incomplete");
    }
    const methods = await request("/api/v1/providers/payments/v1/methods", { countryIso3: address.countryIso3, location: address.position.location, depotType: "regular", cartId: cart.cartId });
    if (methods.flow !== "default" || !Array.isArray(methods.methods) || !methods.defaultMethod) block("payment_unverified");
    const payment = cardShape(methods.defaultMethod);
    const match = methods.methods.find((method) => method.id === payment.id);
    if (!match || JSON.stringify(cardShape(match)) !== JSON.stringify(payment)) block("payment_unverified");
    const hydrated = window.__REACT_QUERY_STATE__.queries.find((entry) => entry.queryKey?.[0] === "PaymentMethod")?.state?.data;
    if (hydrated && JSON.stringify(cardShape(hydrated)) !== JSON.stringify(payment) ||
        cart.paymentMethod && (cart.paymentMethod.id !== payment.id || cart.paymentMethod.type !== "card")) block("payment_unverified");
    const position = address.position;
    const identity = { addressId: address.selected.addressId, addressVersion: address.selected.addressVersion, position };
    const snapshot = { addressHash: await hash(identity), addressId: address.selected.addressId, addressVersion: address.selected.addressVersion,
      ...amounts, cartId: cart.cartId, cartVersion: cart.cartVersion, deliveryConditionsId: cart.deliveryConditionsId,
      deliveryType: cart.deliveryType, flowVersion: cart.orderFlowVersion, offerId: cart.offerId, payment,
      validUntil: cart.validUntil, version: 1 };
    const a = address.selected.address;
    const delivery = [a.city, a.street, a.house, a.flat ? "кв. " + a.flat : null].filter(Boolean).join(", ");
    text(delivery, "address_unavailable");
    const publicQuote = { amountMinor: amounts.amountMinor, currency: "RUB", delivery,
      items: amounts.items.map(({ title, quantity }) => ({ title, quantity })),
      payment: payment.last4 ? "Сохранённая карта " + payment.system + " •••• " + payment.last4 : "Карта по умолчанию " + payment.system };
    return { snapshot, publicQuote, position, cart };
  };
  const errorAnswer = (error, kind) => {
    const reason = typeof error?.reason === "string" ? error.reason : "unavailable";
    if (reason === "signed_out" || reason === "captcha") return { status: reason };
    return ok({ kind, reason });
  };
`;

const prepareOperation = defineYandexOperation({
  about:
    "Reads an exact supported Lavka checkout with its saved address and existing default card.",
  access: "read",
  args: z.object({}),
  id: "lavka.purchase_prepare",
  origin: "https://lavka.yandex.ru/",
  result: prepareResultSchema,
  run: `async function () {${pageSource}
    try {
      const checkout = await readCheckout();
      const expiresAt = new Date(Math.min(Date.parse(checkout.snapshot.validUntil), Date.now() + 120000)).toISOString();
      return ok({ kind: "ready", checkoutKey: checkout.snapshot.cartId, expiresAt,
        publicQuote: checkout.publicQuote, snapshot: { ...checkout.snapshot, expiresAt } });
    } catch (error) { return errorAnswer(error, "blocked"); }
  }`,
  service: "yandex-lavka",
});

const submitOperation = defineYandexOperation({
  about:
    "Submits one previously confirmed supported Lavka checkout after fresh exact comparisons, without retries.",
  access: "purchase",
  args: z.object({ amountMinor: minorAmountSchema, snapshot: snapshotSchema }),
  id: "lavka.purchase_submit",
  origin: "https://lavka.yandex.ru/",
  result: submitResultSchema,
  run: `async function (args) {${pageSource}
    let sent = false;
    try {
      const approved = args.snapshot;
      if (!record(approved) || approved.amountMinor !== args.amountMinor) block("amount_changed");
      if (!Number.isFinite(Date.parse(approved.expiresAt)) || Date.parse(approved.expiresAt) <= Date.now()) block("quote_expired");
      const checkout = await readCheckout();
      const current = checkout.snapshot;
      if (current.amountMinor !== args.amountMinor) block("amount_changed");
      for (const key of Object.keys(current)) {
        if (JSON.stringify(current[key]) !== JSON.stringify(approved[key])) block(key === "payment" ? "payment_changed" : key.startsWith("address") ? "address_changed" : "checkout_changed");
      }
      const finalCart = await request("/api/v1/providers/cart/v1/retrieve", { position: { location: checkout.position.location }, depotType: "regular" });
      const amounts = validateCart(finalCart);
      if (finalCart.cartId !== approved.cartId || finalCart.cartVersion !== approved.cartVersion ||
          finalCart.offerId !== approved.offerId || finalCart.validUntil !== approved.validUntil ||
          finalCart.deliveryConditionsId !== approved.deliveryConditionsId || JSON.stringify(amounts) !== JSON.stringify({
            amountMinor: approved.amountMinor, itemsMinor: approved.itemsMinor, deliveryMinor: approved.deliveryMinor, items: approved.items })) block("checkout_changed");
      const finalAddress = savedAddress();
      const finalHash = await hash({ addressId: finalAddress.selected.addressId, addressVersion: finalAddress.selected.addressVersion, position: finalAddress.position });
      if (finalHash !== approved.addressHash) block("address_changed");
      if (Date.parse(approved.expiresAt) <= Date.now()) block("quote_expired");
      const body = { cartId: approved.cartId, cartVersion: approved.cartVersion, flowVersion: approved.flowVersion,
        position: finalAddress.position, paymentMethodType: "card", paymentMethodId: approved.payment.id,
        useRover: false, depotOrderContext: { depotType: "regular", position: finalAddress.position.location } };
      const response = await request("/api/v1/orders/submit", body, () => {
        if (Date.parse(approved.expiresAt) <= Date.now()) block("quote_expired");
        sent = true;
      });
      const orderId = record(response.data) ? response.data.orderId : response.orderId;
      if (typeof orderId !== "string" || !orderId) return ok({ kind: "unknown" });
      return ok({ kind: "placed", orderId, paymentStatus: "unknown" });
    } catch (error) { return sent ? ok({ kind: "unknown" }) : errorAnswer(error, "rejected"); }
  }`,
  service: "yandex-lavka",
});

export async function prepareLavkaPurchase(
  workspaceId: string
): Promise<z.output<typeof prepareResultSchema>> {
  const outcome = await runYandexOperation(workspaceId, prepareOperation, {});
  if (outcome.kind !== "ok") return { kind: "blocked", reason: outcome.kind };
  const result = prepareResultSchema.safeParse(outcome.data);
  return result.success
    ? result.data
    : { kind: "blocked", reason: "response_invalid" };
}

export async function submitLavkaPurchase(
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

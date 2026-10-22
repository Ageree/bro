import { z } from "zod";
import { purchaseQuoteSchema } from "../lavka/checkout";
import { type JsonValue, defineYandexOperation } from "../operations";
import { runYandexOperation } from "../transport";

const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * A session's ticket widget: the `link` `afisha.prices` gives, the only page
 * an order starts from.
 */
const widgetLink = z
  .string()
  .regex(
    /^https:\/\/widget\.afisha\.yandex\.ru\/w\/sessions\/[A-Za-z0-9+/=_%-]{8,200}(?:\?[A-Za-z0-9=&_.-]{0,200})?$/u
  );

/** What the person asked for: a zone of one session, a count, a card. */
export const afishaPurchaseTarget = z.object({
  // When the person named a card; otherwise the one Yandex offers first.
  cardLast4: z
    .string()
    .regex(/^\d{4}$/u)
    .nullable()
    .default(null),
  count: z.number().int().min(1).max(10),
  link: widgetLink,
  zone: z.string().trim().min(1).max(200),
});

/** The target as the page reads it: an expired quote keeps its card. */
const targetSchema = afishaPurchaseTarget.extend({
  cardId: z
    .string()
    .regex(/^card-/u)
    .nullable()
    .default(null),
});

const snapshotSchema = z.strictObject({
  amountMinor: minor,
  cardId: z.string().regex(/^card-/u),
  cartId: z.string().min(1),
  categoryId: z.number().int(),
  contactsHash: z.string().regex(/^[a-f0-9]{64}$/u),
  count: z.number().int().min(1).max(10),
  expiresAt: z.iso.datetime(),
  extSessionId: z.number().int(),
  feeMinor: minor,
  levelId: z.number().int(),
  link: widgetLink,
  sessionKey: z.string().min(1),
  sourceCategoryId: z.string().min(1),
  sourceLevelId: z.string().min(1),
  unitMinor: minor,
  x: z.number(),
  y: z.number(),
  zone: z.string().min(1),
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
    // The order's own total, when it is not the one the person said yes to.
    orderTotalMinor: minor.optional(),
  }),
  z.object({ kind: z.literal("rejected"), reason: z.string() }),
  z.object({ kind: z.literal("unknown") }),
]);

/**
 * The widget's own requests (widget.afisha.yandex.ru, 608.0), as its
 * client sends them: the CSRF token, uid and request id its page renders
 * into `__config`, `timeout` and `x-force-cors-preflight` on every call,
 * the antibot JWT on the hall plan, the preview and the order, and the
 * client key as `X-Tickets-Client` on the preview. Contacts go as plain
 * strings: an object for one made the preview answer 404 (22.10). The
 * preview holds nothing (`reserveTimer` 0); only `orders/create` does.
 * Only a zone without seats is bought here, by count, with a card already
 * bound to the person's Yandex account (`boundCard`): the widget's own
 * default is SBP, whose order asked the person for an SMS check on 22.10.
 */
/**
 * How long the submit may take, inside the transport's purchase budget
 * (`transport.ts`) after the page loads: the reading before the order,
 * the order's own answer, and the end of reading its payment.
 */
const sendWithinMs = 15_000;
/** How long a quote stands before it is read again. */
const quoteMs = 120_000;
const createWaitMs = 15_000;
const paidWithinMs = 38_000;

const pageSource = String.raw`
  const ok = (data) => ({ status: "ok", data });
  const block = (reason, status) => { throw Object.assign(new Error("checkout blocked"), { reason, status }); };
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const lookalikes = { а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x" };
  const plain = (name) => Array.from(String(name).toLowerCase(), (letter) => /\p{L}|\p{N}/u.test(letter) ? (lookalikes[letter] ?? letter) : "").join("");
  const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const minorOf = (money) => {
    if (!money || money.currencyCode !== "rub" || !Number.isSafeInteger(money.value) || money.value < 0) block("money_invalid");
    return money.value;
  };
  const snake = (info) => ({
    fee: { value: minorOf(info.fee), currency_code: "rub" },
    price: { value: minorOf(info.price), currency_code: "rub" },
    total: { value: minorOf(info.total), currency_code: "rub" },
  });
  let headers = {};
  const call = async (method, path, body, extra, beforeSend, waitMs = 10000) => {
    const options = {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json; charset=UTF-8", ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(waitMs),
    };
    beforeSend?.();
    const response = await fetch(path, options);
    if (response.status === 401) block("signed_out", 401);
    const data = await response.json().catch(() => null);
    // The widget's client takes 201 as well as 200.
    if (response.status < 200 || response.status > 299) block(typeof data?.statusCode === "string" ? "afisha_" + data.statusCode : "http_" + response.status, response.status);
    return data;
  };
  // The tokens the widget's page renders into __config, for the calls after.
  const openWidget = async (link) => {
    const page = await fetch(link, { credentials: "include", signal: AbortSignal.timeout(10000) });
    if (page.status !== 200) block("http_" + page.status);
    const html = await page.text();
    const pick = (pattern) => pattern.exec(html)?.[1] ?? null;
    const csrf = pick(/"X-CSRF-Token":"([^"\\]+)"/);
    const clientKey = pick(/"clientKey":\{"id":"([0-9a-f-]{36})"/);
    if (!csrf || !clientKey) block("widget_changed");
    headers = {
      "X-CSRF-Token": csrf,
      "X-Yandex-Uid": pick(/"X-Yandex-Uid":"(\d+)"/) ?? "",
      "X-Request-Id": pick(/"X-Request-Id":"([^"\\]+)"/) ?? "",
      timeout: "5000",
      "x-force-cors-preflight": "1",
    };
    return clientKey;
  };
  const readCheckout = async (target, cardId) => {
    // A session's key is base64 of its ids: nothing in it may step to
    // another path of the widget's API.
    const key = decodeURIComponent(new URL(target.link).pathname.split("/")[3] || "");
    if (!/^[A-Za-z0-9+=_-]{8,200}$/.test(key)) block("link_invalid");
    const clientKey = await openWidget(target.link);
    const user = await call("GET", "/api/user");
    if (!user?.id) block("signed_out");
    const session = (await call("GET", "/api/tickets/v1/sessions/" + key + "?clientKey=" + clientKey))?.result?.session;
    if (!session) block("session_not_found");
    if (session.saleStatus !== "available") block("sale_closed");
    if (session.sessionAuthRequired || session.hasPresale || session.needPlus || session.event?.needPlus) block("session_restricted");
    if (session.enabledSeatLock || session.enabledSmartCaptcha) block("session_unsupported");
    if ((session.event?.eventSaleAgreementRequirements || []).length || (session.event?.eventSalePersonalTicketDataRequirements || []).length) block("session_unsupported");
    const required = (session.event?.eventSalePersonalDataRequirements || []).map((r) => r.eventSalePersonalDataType);
    const contacts = { fullname: user.fullName?.value, email: user.email?.value, "phone-number": user.phone?.value };
    for (const type of required) {
      if (!(type in contacts)) block("session_unsupported");
      if (typeof contacts[type] !== "string" || !contacts[type].trim()) block("contacts_missing");
    }
    const cartId = (await call("GET", "/api/session/" + key))?.cart?.cart?.cartId;
    if (typeof cartId !== "string" || !cartId) block("cart_missing");
    const antibot = await call("POST", "/api/antibot/check", { sessionKey: key });
    if (antibot?.captchaRequired || typeof antibot?.jwt !== "string") block("captcha");
    const guarded = { "X-Antibot-Token": antibot.jwt };
    let planUrl = null;
    for (let tries = 0; tries < 10 && !planUrl; tries += 1) {
      const answer = await call("GET", "/api/tickets/v4/sessions/" + key + "/hallplan?clientKey=" + clientKey, undefined, guarded);
      if (answer?.status === "completed") planUrl = answer.url;
      else await wait(700);
    }
    if (typeof planUrl !== "string" || !/^https:\/\/[a-z0-9.-]+\.(?:yandex\.net|yandex\.ru)\//.test(planUrl)) block("hallplan_unavailable");
    const plan = (await (await fetch(planUrl, { credentials: "omit", signal: AbortSignal.timeout(10000) })).json())?.result?.hallplan;
    // The zone by its name as afisha.prices gave it, or its one ticket's:
    // exact first, then without case, marks and look-alike Latin letters
    // («VIР lоungе» is «VIP Lounge»); one zone, or none is bought.
    const names = (l) => [l.name, l.categories?.length === 1 ? l.categories[0].name : null].filter((n) => typeof n === "string");
    const levels = plan?.levels || [];
    let found = levels.filter((l) => names(l).includes(target.zone));
    if (!found.length) found = levels.filter((l) => names(l).some((n) => plain(n) === plain(target.zone)));
    if (!found.length) block("zone_not_found");
    if (found.length > 1) block("zone_ambiguous");
    const level = found[0];
    if (level.admission !== true) block("zone_has_seats");
    if (level.categories?.length !== 1) block("zone_ambiguous");
    if ((Number.isInteger(level.availableSeatCount) && level.availableSeatCount < target.count) || !(level.seats || []).length) block("not_enough_tickets");
    const seat = level.seats[0];
    if (!seat || seat.categoryId !== level.categories[0].id) block("zone_ambiguous");
    const category = (plan.categories || []).find((c) => c.id === seat.categoryId);
    if (!category) block("zone_ambiguous");
    const limits = [plan.maxTicketsCount, session.maxTicketsCount].filter((n) => Number.isInteger(n) && n > 0);
    if (limits.length && target.count > Math.min(...limits)) block("too_many_tickets");
    const unit = minorOf(seat.priceInfo.total);
    const preview = async (paymentWay, card) => {
      const item = {
        admission: true, categoryId: String(seat.categoryId), categoryName: category.name,
        cost: seat.priceInfo, originalCost: seat.originalPrice ?? seat.priceInfo,
        extSessionId: String(seat.extSessionId), levelId: seat.levelId ?? level.id,
        seat: { xCoord: seat.seat.xCoord, yCoord: seat.seat.yCoord, linkedSeats: [] },
        sourceCategoryId: seat.sourceCategoryId, sourceLevelId: seat.sourceLevelId, levelName: level.name,
      };
      const started = await call("POST", "/api/session-order-preview/", {
        items: Array.from({ length: target.count }, () => item), deviceId: null, quickPurchaseCardId: card, deviceType: "web",
        supplements: [], paymentWay, usePreOrder: false, sessionKey: key, loyalties: [], lockItems: [], unlockItems: [],
        customerData: { name: contacts.fullname ?? null, email: contacts.email ?? null, phone: contacts["phone-number"] ?? null },
        recreateOrderId: null, promocodes: [], insurance: null,
      }, { "X-Tickets-Client": clientKey, ...guarded });
      const id = started?.orderPreviewInit?.id;
      if (typeof id !== "string") block("preview_failed");
      for (let tries = 0; tries < 16; tries += 1) {
        await wait(500);
        const check = (await call("GET", "/api/session-order-preview/" + encodeURIComponent(id)))?.orderPreviewCheck;
        if (!check || check.status === "PROCESSING") continue;
        const result = check.orderPreviewResult;
        const done = (status) => status === "SUCCESS" || status === "DONE";
        if (!done(check.status) || !done(result?.status)) block("preview_failed");
        // The widget drops errors of other ways to pay (SBP, Split, fintech);
        // any other one stops the card's order.
        const errors = (result.errors || []).filter((e) => !/^(?:SPLIT_|SBP_|FINTECH_SERVICE_NOT_AVAILABLE$|MEDIABILLING_NOT_AVAILABLE$)/.test(String(e?.errorCode || "")));
        if (errors.length) block("preview_" + String(errors[0]?.errorCode || "error").toLowerCase());
        // The order is made with the id the preview started with, as the widget does.
        return { id, result };
      }
      block("preview_timeout");
    };
    const cards = (variants) => (variants || []).filter((v) => v.paymentWay === "boundCard" && !v.isDisabled && /^card-/.test(v.id || ""));
    let card = null;
    let quote = null;
    if (cardId) {
      quote = await preview("boundCard", cardId);
      card = cards(quote.result.paymentVariants).find((v) => v.id === cardId) || null;
    } else {
      const first = await preview(null, null);
      const bound = cards(first.result.paymentVariants);
      card = target.cardLast4
        ? bound.find((v) => String(v.account || "").endsWith(target.cardLast4))
        : bound.find((v) => v.id === first.result.boundPaymentMethod?.id) || bound[0];
      if (card) quote = await preview("boundCard", card.id);
    }
    if (!card || !quote) block(target.cardLast4 ? "card_not_found" : "no_saved_card");
    if (quote.result.boundPaymentMethod?.id && quote.result.boundPaymentMethod.id !== card.id) block("card_changed");
    const total = quote.result.priceInfo?.total?.preview;
    const amountMinor = minorOf(total?.total);
    const feeMinor = minorOf(total?.fee);
    // A discount or a fee the hall plan does not show is a price nobody
    // asked the person about: only the plain sum of the tickets is bought.
    if (amountMinor !== unit * target.count) block("money_inconsistent");
    const last4 = String(card.account || "").slice(-4);
    const contactsHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(required.map((type) => type + "=" + contacts[type]).join("\n")))))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const when = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(session.sessionDate || "");
    const date = when ? Number(when[3]) + " " + months[Number(when[2]) - 1] + " " + when[1] + ", " + when[4] + ":" + when[5] : "";
    const snapshot = {
      amountMinor, cardId: card.id, cartId, categoryId: seat.categoryId, contactsHash, count: target.count,
      extSessionId: seat.extSessionId, feeMinor, levelId: seat.levelId ?? level.id, link: target.link,
      sessionKey: key, sourceCategoryId: seat.sourceCategoryId, sourceLevelId: seat.sourceLevelId,
      unitMinor: unit, x: seat.seat.xCoord, y: seat.seat.yCoord, zone: level.name,
    };
    const publicQuote = {
      amountMinor, currency: "RUB",
      delivery: [session.venue?.name, date].filter(Boolean).join(", ") + (contacts.email ? "; билеты придут на " + contacts.email : ""),
      items: [{ title: (session.event?.name ? session.event.name + " — " : "") + level.name + ", без места", quantity: String(target.count) }],
      payment: "Карта " + (card.paymentSystem || "") + " •• " + last4,
    };
    return { card, category, clientKey, contacts, guarded, key, preview: quote, publicQuote, required, seat, snapshot };
  };
  // The widget's order page reads its order with the client key, as every
  // tickets GET of the widget carries it.
  const orderPath = (orderId, clientKey, rest = "") => "/api/tickets/v2/orders/" + encodeURIComponent(orderId) + rest + "?clientKey=" + encodeURIComponent(clientKey);
  const readOrder = async (orderId, clientKey, waitMs) => {
    try {
      return (await call("GET", orderPath(orderId, clientKey), undefined, undefined, undefined, waitMs))?.result?.order ?? null;
    } catch { return null; }
  };
  const operation = async (orderId, clientKey, type, waitMs) => {
    try {
      return (await call("GET", orderPath(orderId, clientKey, "/operation/" + type), undefined, undefined, undefined, waitMs))?.result?.operation ?? null;
    } catch { return null; }
  };
  const trusted = (url) => typeof url === "string" && /^https:\/\/trust\.yandex\.(?:ru|com|kz|uz)\//.test(url);
  // The widget's order: reserve, the card's payment, then the tickets'
  // issue (sale-approve) — paid is all three. A bank's check is not a
  // moment's step: once it shows for a few rounds it waits for the person,
  // who gets the Trust page the widget itself shows (the order's payment
  // form). Reading stops at the deadline, so a placed order's id always
  // gets back within the call.
  const payment = async (orderId, clientKey, until) => {
    for (let round = 0; ; round += 1) {
      const waitMs = Math.min(4000, Math.max(1000, until - Date.now()));
      const reserve = await operation(orderId, clientKey, "reserve", waitMs);
      const pay = await operation(orderId, clientKey, "pay", waitMs);
      if (pay?.status === "failed" || reserve?.status === "failed") return { paymentStatus: "failed" };
      if (pay?.status === "completed") {
        const sale = await operation(orderId, clientKey, "sale-approve", waitMs);
        if (sale?.status === "completed") return { paymentStatus: "paid" };
        if (sale?.status === "failed") return { paymentStatus: "failed" };
      }
      const flagged = pay?.status !== "completed" && trusted(pay?.redirectUrl3ds ?? reserve?.redirectUrl3ds);
      const last = Date.now() + 1500 >= until;
      if (flagged && (round >= 2 || last)) {
        const form = (await readOrder(orderId, clientKey, waitMs))?.paymentForm?.targetUrl;
        return { paymentStatus: "needs_confirmation", confirmUrl: trusted(form) ? form : (pay?.redirectUrl3ds ?? reserve?.redirectUrl3ds) };
      }
      if (last) return { paymentStatus: "pending" };
      await wait(1500);
    }
  };
  // What the order's page says it costs, to hold against the yes.
  const orderTotal = async (orderId, clientKey) => {
    const order = await readOrder(orderId, clientKey, 4000);
    const total = order?.amountToPay?.total ?? order?.sum?.total;
    return total?.currencyCode === "rub" && Number.isSafeInteger(total.value) ? total.value : null;
  };
  // A refusal of the order that creates nothing: the widget names it for its
  // own checks of the request (the contacts, the CSRF token, the antibot
  // token, a session's password, the orders a person may hold). Anything
  // else after sending, a 5xx or a 409 above all, may have created it.
  // A stale CSRF token (426) is refused before anything, as the widget
  // sends the order again after renewing it.
  const refusedBeforeCreating = (error) => {
    if (error?.status === 426) return true;
    const code = /^afisha_(.+)$/.exec(error?.reason || "")?.[1] || "";
    return [400, 403, 404, 422].includes(error?.status) &&
      /^(?:invalid-(?:input|csrf-token|phone|email|user-data|session-password)|session-password(?:-[a-z-]+)?|session-not-found|max-orders-count-exceeded|antibot(?:-[a-z-]+)?|(?:missing|invalid|expired)_antibot_token|antibot_token_mismatch|antibot_blocked)$/i.test(code);
  };
  const errorAnswer = (error, kind) => {
    const reason = typeof error?.reason === "string" ? error.reason : "unavailable";
    if (reason === "signed_out" || reason === "captcha") return { status: reason };
    return ok({ kind, reason });
  };
`;

const prepareOperation = defineYandexOperation({
  about:
    "Reads one Afisha session's zone without seats as an exact ticket order with the person's saved card, holding nothing.",
  access: "read",
  args: targetSchema,
  id: "afisha.purchase_prepare",
  origin: "https://widget.afisha.yandex.ru/robots.txt",
  result: prepareResultSchema,
  run: `async function (args) {${pageSource}
    try {
      const { publicQuote, snapshot } = await readCheckout(args, args.cardId);
      // The term is set by the server's clock (prepareAfishaPurchase).
      const expiresAt = new Date(0).toISOString();
      return ok({ kind: "ready", checkoutKey: snapshot.sessionKey + ":" + snapshot.levelId + ":" + snapshot.count, expiresAt, publicQuote, snapshot: { ...snapshot, expiresAt } });
    } catch (error) { return errorAnswer(error, "blocked"); }
  }`,
  service: "afisha",
});

const submitOperation = defineYandexOperation({
  about:
    "Places one confirmed Afisha ticket order after a fresh exact comparison, without retries.",
  access: "purchase",
  args: z.object({
    amountMinor: minor,
    snapshot: snapshotSchema,
    validForMs: z.number().int().positive().max(600_000),
  }),
  id: "afisha.purchase_submit",
  origin: "https://widget.afisha.yandex.ru/robots.txt",
  result: submitResultSchema,
  run: `async function (input) {${pageSource}
    const approved = input.snapshot;
    const started = Date.now();
    // The quote's term by the server's clock: the pool browser's own lags
    // after its sandbox wakes from a snapshot.
    const sendBy = started + input.validForMs;
    let sent = false;
    try {
      if (approved.amountMinor !== input.amountMinor) block("amount_changed");
      const current = await readCheckout({ cardLast4: null, count: approved.count, link: approved.link, zone: approved.zone }, approved.cardId);
      for (const key of Object.keys(current.snapshot)) {
        if (JSON.stringify(current.snapshot[key]) !== JSON.stringify(approved[key])) block(key === "amountMinor" ? "amount_changed" : "checkout_changed");
      }
      // A slow reading sends nothing: the order's answer and its payment
      // need the rest of the call, or the order's id is lost with the tab.
      if (Date.now() - started > ${String(sendWithinMs)}) block("slow");
      const { card, category, clientKey, contacts, guarded, key, preview, required, seat, snapshot } = current;
      const item = {
        admission: true, category_id: seat.categoryId, categoryName: category.name, ext_session_id: seat.extSessionId,
        category_type: category.categoryType, priceInfo: snake(seat.priceInfo),
        source_category_id: seat.sourceCategoryId, source_level_id: seat.sourceLevelId,
        seat: { x_coord: seat.seat.xCoord, y_coord: seat.seat.yCoord },
        original_cost: snake(seat.originalPrice ?? seat.priceInfo), level_id: snapshot.levelId, level_name: snapshot.zone,
      };
      const answer = await call("POST", "/api/tickets/v2/orders/create", {
        clientKey, order_preview_id: preview.id, partner_loyalty: [], session_id: key, plus_present: {},
        personal_data: required.map((type) => ({ value: contacts[type], event_sale_personal_data_type: type })),
        personal_data_per_ticket: [], sale_agreements: [], cart_id: snapshot.cartId, device_type: "web",
        payment_way: "bound-card", quick_purchase_card_id: card.id, psp_payment_method_id: card.pspPaymentMethodId,
        items: Array.from({ length: snapshot.count }, () => item), supplements: [],
      }, { ...guarded, timeout: "10000" }, () => {
        // The quote's term holds at the moment of sending, after the reading.
        if (Date.now() >= sendBy) block("quote_expired");
        sent = true;
      }, ${String(createWaitMs)});
      const orderId = answer?.result?.order?.id;
      if (typeof orderId !== "string" || !orderId) return ok({ kind: "unknown" });
      const charged = await orderTotal(orderId, clientKey);
      const differs = charged !== null && charged !== approved.amountMinor;
      return ok({ kind: "placed", orderId, ...(differs ? { orderTotalMinor: charged } : {}), ...await payment(orderId, clientKey, started + ${String(paidWithinMs)}) });
    } catch (error) {
      if (sent && !refusedBeforeCreating(error)) return ok({ kind: "unknown" });
      return errorAnswer(error, "rejected");
    }
  }`,
  service: "afisha",
});

const paymentOperation = defineYandexOperation({
  about:
    "Reads where the card payment of one placed Afisha ticket order stands, without paying or cancelling anything.",
  access: "read",
  args: z.object({ link: widgetLink, orderId: z.string().min(1).max(200) }),
  id: "afisha.purchase_payment",
  origin: "https://widget.afisha.yandex.ru/robots.txt",
  result: paymentSchema,
  run: `async function (args) {${pageSource}
    let clientKey;
    try { clientKey = await openWidget(args.link); } catch { return ok({ paymentStatus: "pending" }); }
    return ok(await payment(args.orderId, clientKey, Date.now()));
  }`,
  service: "afisha",
});

/** The order an approved Afisha quote is for, to read it again when it expired. */
export function afishaTarget(snapshot: JsonValue) {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) return undefined;
  return targetSchema.parse({
    cardId: parsed.data.cardId,
    count: parsed.data.count,
    link: parsed.data.link,
    zone: parsed.data.zone,
  });
}

export async function prepareAfishaPurchase(
  workspaceId: string,
  target: z.input<typeof targetSchema>,
  approvedSnapshot?: JsonValue
): Promise<z.output<typeof prepareResultSchema>> {
  const outcome = await runYandexOperation(
    workspaceId,
    prepareOperation,
    targetSchema.parse(target)
  );
  if (outcome.kind !== "ok") return { kind: "blocked", reason: outcome.kind };
  const parsed = prepareResultSchema.safeParse(outcome.data);
  if (!parsed.success) return { kind: "blocked", reason: "response_invalid" };
  // Two minutes by the server's clock, not the pool browser's.
  const expiresAt = new Date(Date.now() + quoteMs).toISOString();
  const result =
    parsed.data.kind === "ready"
      ? {
          data: {
            ...parsed.data,
            expiresAt,
            snapshot: { ...parsed.data.snapshot, expiresAt },
          },
        }
      : { data: parsed.data };
  if (approvedSnapshot !== undefined && result.data.kind === "ready") {
    // An omitted key of a strict object stays refused: strip it.
    const terms = snapshotSchema.omit({ expiresAt: true }).strip();
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

export async function submitAfishaPurchase(
  workspaceId: string,
  input: { readonly amountMinor: number; readonly snapshot: JsonValue }
): Promise<z.output<typeof submitResultSchema>> {
  const parsed = snapshotSchema.safeParse(input.snapshot);
  if (!parsed.success) return { kind: "rejected", reason: "snapshot_invalid" };
  const validForMs = Date.parse(parsed.data.expiresAt) - Date.now();
  if (!(validForMs > 0)) return { kind: "rejected", reason: "quote_expired" };
  const outcome = await runYandexOperation(workspaceId, submitOperation, {
    amountMinor: input.amountMinor,
    snapshot: parsed.data,
    validForMs: Math.min(Math.floor(validForMs), 600_000),
  });
  // These never ran the function: no tab, a sign-in page or a check.
  if (
    outcome.kind === "signed_out" ||
    outcome.kind === "captcha" ||
    outcome.kind === "unavailable"
  )
    return { kind: "rejected", reason: outcome.kind };
  if (outcome.kind !== "ok") return { kind: "unknown" };
  const result = submitResultSchema.safeParse(outcome.data);
  return result.success ? result.data : { kind: "unknown" };
}

/** The payment of a placed order now; `pending` when it cannot be read. */
export async function readAfishaPayment(
  workspaceId: string,
  snapshot: JsonValue,
  orderId: string
) {
  const link = snapshotSchema.safeParse(snapshot).data?.link;
  if (link === undefined) return { paymentStatus: "pending" as const };
  const outcome = await runYandexOperation(workspaceId, paymentOperation, {
    link,
    orderId,
  });
  const result =
    outcome.kind === "ok" ? paymentSchema.safeParse(outcome.data) : undefined;
  return result?.success ? result.data : { paymentStatus: "pending" as const };
}

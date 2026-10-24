import { z } from "zod";
import { defineYandexOperation } from "../operations";
import { goPlace } from "./estimate";
import { goApiPage, goSession } from "./session";

const ride = z.object({
  car: z.string().nullable(),
  from: z.string().nullable(),
  orderId: z.string(),
  price: z.number().nullable(),
  status: z.string().nullable(),
  to: z.string().nullable(),
});

const failed = z.object({ kind: z.literal("failed"), reason: z.string() });

/**
 * The person's ride that is on now, as the app finds it when it opens:
 * `launch` lists the orders in progress (the order history does not, until a
 * ride is over), `taxiontheway` tells where the first one stands. Yandex's
 * own record, so a second booking is never made while one is on, whatever
 * happened to an earlier call.
 */
const activeRideSource = String.raw`
  const activeRide = async (seen = () => {}) => {
    const launch = await session.post("/3.0/launch", { id: session.userId });
    if (launch.wall || launch.error) throw Object.assign(new Error("launch"), { wall: launch.wall });
    seen(launch);
    const orderId = (launch.orders || []).find((o) => typeof o.orderid === "string")?.orderid;
    if (!orderId) return null;
    const t = await session.post("/3.0/taxiontheway", { orderid: orderId, format_currency: true, id: session.userId, show_text: true });
    const route = (t.request?.route || []).map((point) => point.short_text || point.fullname || null);
    const d = t.driver || {};
    const car = [d.color, d.car_model || d.model, d.plates || d.car_number].filter((x) => typeof x === "string" && x).join(" ");
    return {
      orderId,
      status: typeof t.status === "string" ? t.status : null,
      from: route[0] ?? null,
      to: route.length > 1 ? route[route.length - 1] : null,
      price: typeof t.final_cost === "number" ? t.final_cost : null,
      car: car || null,
    };
  };
`;

/**
 * Books an econom ride in one tab, the way the site does: the places as
 * Yandex resolves them, a fixed-price quote, a draft and its commit. A ride
 * that is already on answers instead of a second one. The draft is never
 * sent twice; a commit Yandex answers 202 is sent again, as the site does,
 * since it names the same draft.
 *
 * A ride for someone else is the site's «Заказ другому человеку»: the
 * passenger's number and name go into the draft (`extra_contact_phone`,
 * `extra_passenger_name`), and Yandex texts them the car and the driver; the
 * ride stays in the person's account and on their payment. A tariff can
 * refuse it (`order_for_other_prohibited` of its service level). A number
 * of the account itself (`launch` lists them) is the person's own ride.
 *
 * The person's own ride with `quietOwnRide` goes as the Go app books it,
 * with `dont_sms`: the site's draft sends it false, and Yandex texted the
 * person's phone «Вам оплатили такси» with a link to a page where the
 * pickup cannot be changed, as if someone else had ordered it (owner, 24.10).
 */
export const goBookOperation = defineYandexOperation({
  about:
    "Book an econom Yandex Go ride now. from and to: address text or [longitude, latitude]; payment: cash, card or current (what is selected in Go); cardLast4: with payment card, the last four digits of the card the person named; maxPriceRub: do not book above it; passengerPhone and passengerName: only when the ride is for someone else, their number and name: Yandex texts them the car and the driver, and the person pays.",
  access: "purchase",
  args: z.object({
    cardLast4: z
      .string()
      .regex(/^\d{4}$/u)
      .optional(),
    from: goPlace,
    maxPriceRub: z.number().positive().optional(),
    near: z
      .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
      .default([37.6177, 55.7558]),
    passengerName: z.string().max(60).optional(),
    passengerPhone: z.string().max(40).optional(),
    payment: z.enum(["cash", "card", "current"]).default("current"),
    quietOwnRide: z.boolean().optional(),
    to: goPlace,
  }),
  id: "go.book",
  origin: goApiPage,
  result: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("booked"),
      orderId: z.string(),
      status: z.string(),
      price: z.number(),
      from: z.string(),
      to: z.string(),
      payment: z.string(),
      passenger: z
        .object({ phone: z.string(), name: z.string().nullable() })
        .optional(),
    }),
    z.object({ kind: z.literal("already_active"), ride }),
    z.object({
      kind: z.literal("over_limit"),
      price: z.number(),
      from: z.string(),
      to: z.string(),
    }),
    z.object({ kind: z.literal("unknown"), orderId: z.string() }),
    failed.extend({ unverifiedCardId: z.string().optional() }),
  ]),
  run: `async function (args) {${goSession}
  const session = await goSession();
  if (session.wall || session.error) return goAnswer(session);
  const ok = (data) => ({ status: "ok", data });
  const fail = (reason) => ok({ kind: "failed", reason });
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  ${activeRideSource}
  const place = async (query, type) => {
    let position = query;
    if (!Array.isArray(query)) {
      const suggest = await session.post("/4.0/persuggest/v1/suggest", {
        type, client_id: "turboapp-taxi", action: "user_input", part: query, sticky: false,
        state: { accuracy: 0, location: args.near, fields: [] }, position: args.near,
      });
      const hit = (suggest.results || []).find((r) => Array.isArray(r.position));
      if (!hit) return null;
      position = hit.position;
    }
    const final = await session.post("/4.0/persuggest/v1/finalsuggest", {
      state: { accuracy: 0, location: position, selected_class: "econom", fields: [] },
      type, position, action: "pin_drop", sticky: false,
    });
    const r = (final.results || []).find((x) => x.type === "address" && Array.isArray(x.position));
    if (!r) return null;
    return { fullname: r.text, geopoint: r.position, short_text: r.title?.text || r.text, type: "address",
      ...(r.city ? { city: r.city } : {}), ...(r.uri ? { uri: r.uri } : {}) };
  };
  // Independent reads go out together: Yandex's own record of a ride that is
  // on, the place the ride starts from (and, once it is found, the cards at
  // that point), and the place it goes to. Nothing is written until all are
  // in. A ride that is on still answers first, whatever the rest found or
  // however they failed, and the cards are asked at the same point as before.
  const selectedPayment = async () => {
    try {
      const db = await new Promise((done, fault) => {
        const open = indexedDB.open("turboapp-taxi");
        open.onsuccess = () => done(open.result);
        open.onerror = () => fault(open.error);
      });
      const stored = await new Promise((done) => {
        const get = db.transaction("redux-persist", "readonly").objectStore("redux-persist").get("persist:payment-methods");
        get.onsuccess = () => done(get.result);
        get.onerror = () => done(null);
      });
      return (typeof stored === "string" ? JSON.parse(stored) : stored)?.selectedPaymentMethod ?? null;
    } catch {
      return null;
    }
  };
  const selected = args.payment === "cash" ? null : await selectedPayment();
  const needsCards = args.payment === "card" || (args.payment === "current" && selected?.type === "card");
  const startAndCards = async () => {
    const start = await place(args.from, "a");
    if (!start || !needsCards) return { start, methods: null };
    const methods = await session.post("/3.0/paymentmethods", { location: start.geopoint, id: session.userId });
    return { start, methods };
  };
  // The account's own numbers, as launch lists them: a passenger with one of
  // them is the person themselves.
  let accountPhones = [];
  const accountRead = (launch) => {
    accountPhones = [launch.phone, ...Object.keys(launch.phones || {})].filter((x) => typeof x === "string" && x);
  };
  const [activeRead, startRead, toRead] = await Promise.allSettled([activeRide(accountRead), startAndCards(), place(args.to, "b")]);
  if (activeRead.status === "rejected") throw activeRead.reason;
  if (activeRead.value) return ok({ kind: "already_active", ride: activeRead.value });
  if (startRead.status === "rejected") throw startRead.reason;
  if (toRead.status === "rejected") throw toRead.reason;
  const { start: from, methods } = startRead.value;
  const to = toRead.value;
  if (!from) return fail("from_not_found");
  if (!to) return fail("to_not_found");
  let payment = { type: "cash", label: "наличные" };
  if (args.payment !== "cash") {
    if (!needsCards) {
      if (selected?.type !== "cash") return fail("payment_unsupported");
    } else {
      const pending = methods.card?.unverified_cards || [];
      const unverified = new Set(pending.map((c) => c.id));
      const cards = (methods.card?.available_cards || []).filter((c) => !c.is_hidden && !unverified.has(c.id));
      // The card the person named, else the one selected in Go, else (for card) the first.
      const named = args.payment === "card" ? args.cardLast4 : undefined;
      const wanted = (c) => named ? String(c.number || "").endsWith(named) : c.id === selected?.id;
      const card = cards.find(wanted) || (args.payment === "card" && !named ? cards[0] : null);
      if (!card) {
        // The card to verify: the wanted one, else the first Go holds back.
        const held = pending.find(wanted) || (named ? null : pending[0]);
        if (named && !held) return fail("card_not_found");
        return ok({ kind: "failed", reason: "no_verified_card", ...(typeof held?.id === "string" ? { unverifiedCardId: held.id } : {}) });
      }
      payment = { type: "card", id: card.id, label: [card.system, card.number].filter(Boolean).join(" ") || "карта" };
    }
  }
  const quote = await session.post("/3.0/routestats", {
    id: session.userId, route: [from.geopoint, to.geopoint], selected_class: "econom", format_currency: true,
    requirements: {}, payment: { type: payment.type, ...(payment.id ? { payment_method_id: payment.id } : {}) },
    summary_version: 2, is_lightweight: false, supports_paid_options: true, supported_markup: "tml-0.1", extended_description: true,
  });
  if (quote.wall) return { status: "signed_out" };
  const level = (quote.service_levels || []).find((l) => l.class === "econom");
  const price = Number(level?.max_price_as_decimal);
  if (!quote.offer || !level || level.is_fixed_price !== true || !Number.isFinite(price)) return fail("no_fixed_price");
  // The site's «Заказ другому человеку»: the number as its form keeps it.
  const passengerPhone = String(args.passengerPhone || "").replace(/[^0-9+]/g, "");
  const tenDigits = (phone) => phone.replace(/[^0-9]/g, "").slice(-10);
  const ownNumber = accountPhones.some((phone) => tenDigits(phone) === tenDigits(passengerPhone));
  const passenger = passengerPhone && !ownNumber ? { phone: passengerPhone, name: args.passengerName || null } : null;
  if (passenger && level.order_for_other_prohibited === true) return fail("order_for_other_unavailable");
  if (args.maxPriceRub !== undefined && price > args.maxPriceRub) {
    return ok({ kind: "over_limit", price, from: from.short_text, to: to.short_text });
  }
  const draft = await session.post("/external/3.0/orderdraft", {
    id: session.userId, class: ["econom"], offer: quote.offer, parks: [], route: [from, to], requirements: {},
    payment: { type: payment.type, ...(payment.id ? { payment_method_id: payment.id } : {}) },
    driverclientchat_enabled: true,
    ...(passenger ? { extra_contact_phone: passenger.phone, ...(passenger.name ? { extra_passenger_name: passenger.name } : {}) } : {}),
    ...(!passenger && args.quietOwnRide === true ? { dont_sms: true } : {}),
  });
  if (draft.wall) return { status: "signed_out" };
  // A draft is not an order: refused, nothing is booked.
  if (typeof draft.orderid !== "string" || !draft.orderid) return fail("draft_" + (draft.error || "refused"));
  const orderId = draft.orderid;
  try {
    let commit = await session.post("/external/3.0/ordercommit", { id: session.userId, orderid: orderId });
    for (let attempt = 0; commit.error === "http_202" && attempt < 3; attempt++) {
      await sleep(3000);
      commit = await session.post("/external/3.0/ordercommit", { id: session.userId, orderid: orderId });
    }
    if (typeof commit.status === "string") {
      return ok({ kind: "booked", orderId, status: commit.status, price, from: from.short_text, to: to.short_text, payment: payment.label, ...(passenger ? { passenger } : {}) });
    }
  } catch {}
  return ok({ kind: "unknown", orderId });
}`,
  service: "go",
});

/** The ride that is on now, or none. */
export const goRideOperation = defineYandexOperation({
  about:
    "The person's Yandex Go ride that is on now: status, car, route and price; ride is null when there is none.",
  access: "read",
  args: z.object({}),
  id: "go.ride",
  origin: goApiPage,
  result: z.object({ ride: ride.nullable() }),
  run: `async function () {${goSession}
  const session = await goSession();
  if (session.wall || session.error) return goAnswer(session);
  ${activeRideSource}
  return { status: "ok", data: { ride: await activeRide() } };
}`,
  service: "go",
});

/**
 * Cancels the ride that is on now, as the site's cancel button does
 * (`taxiontheway` with `break: user`), unless Yandex says it cannot be
 * cancelled any more.
 */
export const goCancelOperation = defineYandexOperation({
  about: "Cancel the person's Yandex Go ride that is on now.",
  access: "purchase",
  args: z.object({}),
  id: "go.cancel",
  origin: goApiPage,
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("cancelled"), orderId: z.string() }),
    z.object({ kind: z.literal("no_ride") }),
    z.object({ kind: z.literal("cannot_cancel"), status: z.string() }),
    failed,
  ]),
  run: `async function () {${goSession}
  const session = await goSession();
  if (session.wall || session.error) return goAnswer(session);
  const ok = (data) => ({ status: "ok", data });
  const launch = await session.post("/3.0/launch", { id: session.userId });
  if (launch.wall) return { status: "signed_out" };
  const orderId = (launch.orders || []).find((o) => typeof o.orderid === "string")?.orderid;
  if (!orderId) return ok({ kind: "no_ride" });
  const order = { orderid: orderId, format_currency: true, id: session.userId, show_text: true };
  const now = await session.post("/3.0/taxiontheway", order);
  if (now.wall) return { status: "signed_out" };
  if (now.cancel_disabled === true || now.cancel_state?.state === "disabled") {
    return ok({ kind: "cannot_cancel", status: String(now.status) });
  }
  const after = await session.post("/3.0/taxiontheway", { ...order, break: "user" });
  return after.status === "cancelled"
    ? ok({ kind: "cancelled", orderId })
    : ok({ kind: "failed", reason: after.error || String(after.status) });
}`,
  service: "go",
});

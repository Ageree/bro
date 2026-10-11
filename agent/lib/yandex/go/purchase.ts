import { z } from "zod";
import { type JsonValue, defineYandexOperation } from "../operations";
import { runYandexOperation } from "../transport";
import { goApiPage, goSession } from "./session";

const pointSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);

export const goPurchaseRouteSchema = z
  .tuple([pointSchema, pointSchema])
  .refine(
    ([from, to]) => from[0] !== to[0] || from[1] !== to[1],
    "The pickup and destination must be distinct explicit coordinates."
  );

const minorSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const routePointSchema = z.strictObject({
  fullname: z.string().min(1).max(500),
  geopoint: pointSchema,
  short_text: z.string().min(1).max(500),
  type: z.literal("address"),
  city: z.string().max(200).optional(),
  uri: z.string().max(2000).optional(),
});
const routeSchema = z.tuple([routePointSchema, routePointSchema]);

export const goPublicQuoteSchema = z.strictObject({
  amountMinor: minorSchema,
  currency: z.literal("RUB"),
  route: routeSchema,
  tariff: z.literal("econom"),
  tariffName: z.string().min(1).max(100),
  payment: z.enum(["CASH", "SAVED_CARD"]),
  paymentLabel: z.string().min(1).max(100),
});

const paymentMethodSchema = z.strictObject({
  type: z.enum(["cash", "card"]),
  id: z.string().min(1).max(200),
});
const snapshotSchema = goPublicQuoteSchema.extend({
  expiresAt: z.iso.datetime(),
  offer: z.string().min(1).max(10000),
  providerUserId: z.string().regex(/^[a-f0-9]{32}$/u),
  paymentMethod: paymentMethodSchema,
});

const prepareResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blocked"), reason: z.string() }),
  z.object({
    kind: z.literal("ready"),
    checkoutKey: z.string().min(1),
    expiresAt: z.iso.datetime(),
    publicQuote: goPublicQuoteSchema,
    snapshot: snapshotSchema,
  }),
]);
const draftResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drafted"), orderId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("rejected"), reason: z.string() }),
  z.object({ kind: z.literal("unknown") }),
]);
const commitResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("active"), orderId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("unknown") }),
]);

const pageSource = String.raw`
  ${goSession}
  const ok = (data) => ({ status: "ok", data });
  const block = (reason) => { throw Object.assign(new Error("booking blocked"), { reason }); };
  const text = (value, reason) => typeof value === "string" && value.length > 0 ? value : block(reason);
  const money = (value) => {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.test(value)) block("money_invalid");
    const [whole, fraction = ""] = value.split(".");
    const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) block("money_invalid");
    return Number(minor);
  };
  let session;
  const requireSession = async () => {
    session = await goSession();
    if (session.wall || session.error) block(session.wall || session.error);
  };
  const currentPayment = async (route) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("turboapp-taxi");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("idb_read_failed"));
    });
    const stored = await new Promise((resolve, reject) => {
      const request = db.transaction("redux-persist", "readonly").objectStore("redux-persist").get("persist:payment-methods");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("idb_read_failed"));
    });
    const state = typeof stored === "string" ? JSON.parse(stored) : stored;
    const selected = state?.selectedPaymentMethod;
    const response = await session.post("/3.0/paymentmethods", { location: route[0].geopoint, id: session.userId });
    if (response.wall || response.error) block(response.wall || response.error);
    if (!selected || selected.zoneAvailable !== true || selected.isYandexCard ||
        selected.userCostCenter || selected.costCenter || !["cash", "card"].includes(selected.type)) block("payment_unsupported");
    const id = text(selected.id, "payment_unsupported");
    if (selected.type === "cash") return { payment: "CASH", paymentLabel: "НАЛИЧНЫМИ (CASH)", paymentMethod: { type: "cash", id } };
    const cards = response.card?.available_cards;
    if (response.card?.payment_available !== true || !Array.isArray(cards) ||
        !Array.isArray(response.card?.unverified_cards) || response.card.unverified_cards.some((card) => card.id === id)) block("payment_unsupported");
    const matches = cards.filter((card) => card.id === id);
    if (matches.length !== 1) block("payment_unsupported");
    const card = matches[0];
    if (card.is_hidden) block("payment_unsupported");
    const system = text(card.system, "payment_unsupported");
    const last4 = typeof card.number === "string" ? /^[*•xX\s-]*(\d{4})$/.exec(card.number.trim())?.[1] : null;
    if (!last4) block("payment_unsupported");
    return { payment: "SAVED_CARD", paymentLabel: system + " •••• " + last4, paymentMethod: { type: "card", id } };
  };
  const resolvePoint = async (point, type) => {
    const response = await session.post("/4.0/persuggest/v1/finalsuggest", {
      state: { accuracy: 0, location: point, selected_class: "econom", fields: [] },
      type, position: point, action: "pin_drop", sticky: false,
    });
    if (response.wall || response.error) block(response.wall || response.error);
    const matches = (response.results || []).filter((item) => item.type === "address");
    if (matches.length !== 1) block("route_ambiguous");
    const item = matches[0];
    if (!Array.isArray(item.position) || item.position.length !== 2 ||
        !item.position.every(Number.isFinite) || item.position[0] < -180 || item.position[0] > 180 ||
        item.position[1] < -90 || item.position[1] > 90) block("route_invalid");
    if (item.entrance || item.comment) block("route_unsupported");
    const routePoint = { fullname: text(item.text, "route_invalid"), geopoint: item.position,
      short_text: text(item.title?.text, "route_invalid"), type: "address" };
    for (const key of ["city", "uri"]) {
      if (item[key] !== undefined) {
        if (typeof item[key] !== "string") block("route_invalid");
        routePoint[key] = item[key];
      }
    }
    return routePoint;
  };
  const quote = async (route) => {
    const payment = await currentPayment(route);
    const response = await session.post("/3.0/routestats", {
      route: route.map((point) => point.geopoint), selected_class: "econom", format_currency: true,
      requirements: {}, payment: { type: payment.paymentMethod.type,
        ...(payment.paymentMethod.type === "card" ? { payment_method_id: payment.paymentMethod.id } : {}) }, id: session.userId,
      summary_version: 2, is_lightweight: false, supports_paid_options: true,
      supported_markup: "tml-0.1", extended_description: true,
    });
    if (response.wall || response.error) block(response.wall || response.error);
    if (response.currency_rules?.code !== "RUB") block("currency_unsupported");
    if (response.is_fixed_price !== true) block("tariff_unsupported");
    const levels = (response.service_levels || []).filter((level) => level.class === "econom");
    if (levels.length !== 1) block("tariff_ambiguous");
    const level = levels[0];
    if (level.is_hidden !== false || level.is_fixed_price !== true) block("tariff_unsupported");
    if (!level.tariff_requirements || typeof level.tariff_requirements !== "object" ||
        Array.isArray(level.tariff_requirements) || Object.keys(level.tariff_requirements).length !== 0) block("requirements_unsupported");
    const offer = text(response.offer, "offer_missing");
    if (level.offer !== offer) block("offer_inconsistent");
    const amountMinor = money(level.max_price_as_decimal);
    const raw = level.prices?.raw?.final_price;
    const exact = level.prices?.args?.final_price;
    if ((typeof raw !== "number" && typeof raw !== "string") || money(String(raw)) !== amountMinor ||
        (typeof exact !== "number" && typeof exact !== "string") || money(String(exact)) !== amountMinor) block("money_inconsistent");
    return { amountMinor, currency: "RUB", route, tariff: "econom",
      tariffName: text(level.name, "tariff_invalid"), ...payment, offer, providerUserId: session.userId };
  };
`;

const prepareOperation = defineYandexOperation({
  about:
    "Reads an exact econom Go quote using the current supported cash or verified saved card for two unambiguous coordinates, without creating a draft.",
  access: "read",
  args: z.strictObject({ route: goPurchaseRouteSchema }),
  id: "go.purchase_prepare",
  origin: goApiPage,
  result: prepareResultSchema,
  run: `async function (args) {${pageSource}
    try {
      await requireSession();
      const route = [await resolvePoint(args.route[0], "a"), await resolvePoint(args.route[1], "b")];
      if (JSON.stringify(route[0].geopoint) === JSON.stringify(route[1].geopoint)) block("route_ambiguous");
      const current = await quote(route);
      const expiresAt = new Date(Date.now() + 120000).toISOString();
      const { offer, providerUserId, paymentMethod, ...publicQuote } = current;
      return ok({ kind: "ready", checkoutKey: JSON.stringify(route.map((point) => point.geopoint)), expiresAt,
        publicQuote, snapshot: { ...current, expiresAt } });
    } catch (error) { return ok({ kind: "blocked", reason: error.reason || "read_failed" }); }
  }`,
  service: "go",
});

const draftOperation = defineYandexOperation({
  about:
    "Sends one Go orderdraft after a fresh exact fare comparison; no retries.",
  access: "purchase",
  args: z.strictObject({ amountMinor: minorSchema, snapshot: snapshotSchema }),
  id: "go.purchase_draft",
  origin: goApiPage,
  result: draftResultSchema,
  run: `async function (args) {${pageSource}
    let sent = false;
    try {
      await requireSession();
      const approved = args.snapshot;
      if (Date.parse(approved.expiresAt) <= Date.now()) block("quote_expired");
      if (approved.amountMinor !== args.amountMinor || approved.providerUserId !== session.userId) block("snapshot_changed");
      const current = await quote(approved.route);
      for (const key of ["amountMinor", "currency", "route", "tariff", "tariffName", "payment", "paymentLabel", "paymentMethod", "providerUserId"]) {
        if (JSON.stringify(current[key]) !== JSON.stringify(approved[key])) block("quote_changed");
      }
      if (Date.parse(approved.expiresAt) <= Date.now()) block("quote_expired");
      sent = true;
      const response = await session.post("/external/3.0/orderdraft", {
        id: session.userId, class: [approved.tariff], payment: { type: approved.paymentMethod.type, payment_method_id: approved.paymentMethod.id },
        offer: current.offer, route: approved.route, requirements: {},
      });
      if (response.wall || response.error) return ok({ kind: "unknown" });
      const orderId = response.orderid;
      if (typeof orderId !== "string" || !orderId || orderId.length > 200) return ok({ kind: "unknown" });
      return ok({ kind: "drafted", orderId });
    } catch (error) { return ok(sent ? { kind: "unknown" } : { kind: "rejected", reason: error.reason || "read_failed" }); }
  }`,
  service: "go",
});

const commitOperation = defineYandexOperation({
  about:
    "Sends one Go ordercommit for the original durable draft; no retries or payment retries.",
  access: "purchase",
  args: z.strictObject({
    orderId: z.string().min(1).max(200),
    snapshot: snapshotSchema,
  }),
  id: "go.purchase_commit",
  origin: goApiPage,
  result: commitResultSchema,
  run: `async function (args) {${pageSource}
    try {
      await requireSession();
      if (session.userId !== args.snapshot.providerUserId ||
          Date.parse(args.snapshot.expiresAt) <= Date.now()) return ok({ kind: "unknown" });
      const payment = await currentPayment(args.snapshot.route);
      if (JSON.stringify(payment.paymentMethod) !== JSON.stringify(args.snapshot.paymentMethod) ||
          payment.paymentLabel !== args.snapshot.paymentLabel || Date.parse(args.snapshot.expiresAt) <= Date.now()) return ok({ kind: "unknown" });
      const response = await session.post("/external/3.0/ordercommit", { id: session.userId, orderid: args.orderId });
      if (response.wall || response.error || !["search", "driving", "waiting", "calling", "transporting", "boarding"].includes(response.status)) return ok({ kind: "unknown" });
      return ok({ kind: "active", orderId: args.orderId });
    } catch { return ok({ kind: "unknown" }); }
  }`,
  service: "go",
});

export async function prepareGoPurchase(
  workspaceId: string,
  input: z.output<typeof prepareOperation.args>
): Promise<z.output<typeof prepareResultSchema>> {
  const parsed = prepareOperation.args.safeParse(input);
  if (!parsed.success)
    return { kind: "blocked" as const, reason: "route_unsupported" };
  const outcome = await runYandexOperation(
    workspaceId,
    prepareOperation,
    parsed.data
  );
  if (outcome.kind !== "ok")
    return { kind: "blocked" as const, reason: outcome.kind };
  const result = prepareResultSchema.safeParse(outcome.data);
  return result.success
    ? result.data
    : { kind: "blocked" as const, reason: "response_invalid" };
}

export async function draftGoPurchase(
  workspaceId: string,
  input: { amountMinor: number; snapshot: JsonValue }
): Promise<z.output<typeof draftResultSchema>> {
  const parsed = draftOperation.args.safeParse(input);
  if (!parsed.success)
    return { kind: "rejected" as const, reason: "snapshot_invalid" };
  const outcome = await runYandexOperation(
    workspaceId,
    draftOperation,
    parsed.data
  );
  if (outcome.kind !== "ok") return { kind: "unknown" as const };
  const result = draftResultSchema.safeParse(outcome.data);
  return result.success ? result.data : { kind: "unknown" as const };
}

export async function commitGoPurchase(
  workspaceId: string,
  input: { orderId: string; snapshot: JsonValue }
): Promise<z.output<typeof commitResultSchema>> {
  const parsed = commitOperation.args.safeParse(input);
  if (!parsed.success) return { kind: "unknown" as const };
  const outcome = await runYandexOperation(
    workspaceId,
    commitOperation,
    parsed.data
  );
  if (outcome.kind !== "ok") return { kind: "unknown" as const };
  const result = commitResultSchema.safeParse(outcome.data);
  return result.success ? result.data : { kind: "unknown" as const };
}

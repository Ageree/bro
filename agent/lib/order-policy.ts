/**
 * Pure order parse. Never invent a merchant order id: use one from the
 * result text, or `pending:<short>` only when title and price are both known.
 */

export type OrderMerchant = "wb" | "ozon" | "other";
export type OrderStatus = "placed" | "cancelled" | "unknown";

export type ParsedOrder = {
  merchant: OrderMerchant;
  merchantOrderId: string;
  title: string;
  priceRub: number;
  status: OrderStatus;
  pickup?: string;
};

export type ParseOrderArgs = {
  task: string;
  result?: string | null;
  hosts?: readonly string[];
  pay?: boolean | { hosts?: readonly string[] };
  now?: number;
};

const CANCEL =
  /(?:отмен(?:и|ить|ён|ен|ена|или|яю|яем)|аннулир|cancel(?:led|ed)?)/iu;

const FAIL =
  /(?:не\s+удалось|не\s+получилось|ошибк[аи]|payment\s+failed|отклон(?:ён|ен)|не\s+оплачен)/iu;

const SUCCESS =
  /(?:оформлен|оплачен|оплатил|куплен|купил|заказ\s+принят|successfully|placed|confirmed|paid)/iu;

const PAN = /\b(?:\d[ \t-]*){13,19}\b/;

const TITLE_LABEL =
  /(?:товар|название|позици[яи]|купил(?:а|и)?|заказал(?:а|и)?|title)\s*[:\-–—]\s*(.+)/iu;

const PRICE_LABEL =
  /(?:сумма|итого|цена|оплачено|к\s+оплате|стоимость|paid|total|price)\s*[:\-–—]?\s*(\d[\d\s\u00a0]*(?:[.,]\d{1,2})?)\s*(?:₽|руб|rub)?/iu;

const PRICE_MARKED =
  /(\d{1,3}(?:[\s\u00a0]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:₽|руб(?:л(?:ей|я|ь))?\.?|rub)/giu;

const TASK_PAID =
  /(?:за|стоимость|цена)\s+(\d[\d\s\u00a0]*(?:[.,]\d{1,2})?)\s*(?:₽|руб|rub)?/iu;

const ORDER_LABEL =
  /(?:номер\s+заказа|заказ(?:а)?\s*№|order(?:\s*(?:number|id|#)|№)|id\s+заказа)\s*[:\-–—]?\s*([A-Za-z0-9-]{5,32})/iu;

const ORDER_BARE = /(?:заказ|order)\s+(?:№\s*)?([A-Za-z0-9-]{6,32})/iu;

const PICKUP =
  /(?:пвз|пункт\s+выдачи|самовывоз|адрес\s+пвз|pickup)\s*[:\-–—]\s*(.+)/iu;

const BUY_PREFIX =
  /^(?:купи(?:ть)?|закаж(?:и|ать)|оплати(?:ть)?|выкупи(?:ть)?|бери|возьми|оформи(?:ть)?(?:\s+заказ)?)\s*/iu;

const BUY_ONLY =
  /^(?:купи(?:ть)?|закаж(?:и|ать)|оплати(?:ть)?|выкупи(?:ть)?|бери|возьми|оформи(?:ть)?(?:\s+заказ)?)$/iu;

const SHOP_TAIL =
  /\s+(?:на\s+)?(?:wildberries|вайлдберр\w*|wb\.ru|wb|вб|ozon\.ru|ozon|озон)\b.*$/iu;

function hostKey(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    const first = trimmed.replace(/^www\./, "").split("/")[0];
    return first ?? "";
  }
}

export function merchantFromHost(host: string): OrderMerchant {
  const key = hostKey(host);
  const raw = host.trim().toLowerCase();
  if (
    key.includes("wildberries") ||
    raw.includes("wildberries") ||
    key === "wb.ru" ||
    key.endsWith(".wb.ru") ||
    raw.includes("wb.ru")
  ) {
    return "wb";
  }
  if (key.includes("ozon") || raw.includes("ozon") || raw.includes("озон")) {
    return "ozon";
  }
  return "other";
}

export function merchantFromTask(task: string): OrderMerchant {
  const t = task.toLowerCase();
  if (
    t.includes("wildberries") ||
    t.includes("вайлдберр") ||
    t.includes("wb.ru") ||
    /(?:^|[^\p{L}])(?:wb|вб)(?:[^\p{L}]|$)/iu.test(task)
  ) {
    return "wb";
  }
  if (t.includes("ozon") || t.includes("озон")) return "ozon";
  return "other";
}

function payHosts(pay: ParseOrderArgs["pay"]): readonly string[] {
  if (pay && typeof pay === "object" && pay.hosts) return pay.hosts;
  return [];
}

export function resolveMerchant(args: {
  task: string;
  result?: string | null;
  hosts?: readonly string[];
  pay?: ParseOrderArgs["pay"];
}): OrderMerchant {
  for (const host of [...(args.hosts ?? []), ...payHosts(args.pay)]) {
    const merchant = merchantFromHost(host);
    if (merchant !== "other") return merchant;
  }
  const fromTask = merchantFromTask(args.task);
  if (fromTask !== "other") return fromTask;
  if (args.result) {
    const fromResult = merchantFromTask(args.result);
    if (fromResult !== "other") return fromResult;
  }
  return "other";
}

function stripSecrets(text: string): string {
  return text.replace(PAN, "").replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.trim().slice(0, max);
}

function looksLikePan(id: string): boolean {
  const digits = id.replace(/\D/g, "");
  return digits.length >= 13 && digits.length <= 19 && digits.length === id.replace(/[\s-]/g, "").length;
}

function parseRub(raw: string): number | undefined {
  const compact = raw.replace(/[\s\u00a0]/g, "").replace(",", ".");
  const n = Number(compact);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const rub = Math.round(n);
  if (rub > 10_000_000) return undefined;
  return rub;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Stable short id when the merchant did not print an order number. */
export function pendingOrderId(title: string, priceRub: number, now = Date.now()): string {
  const day = utcDay(now);
  const input = `${title.trim().toLowerCase()}|${priceRub}|${day}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `pending:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/)[0] ?? text;
  return clip(stripSecrets(line), 200);
}

function extractOrderId(text: string): string | undefined {
  const labeled = text.match(ORDER_LABEL);
  const raw = labeled?.[1] ?? text.match(ORDER_BARE)?.[1];
  if (!raw) return undefined;
  const id = raw.trim();
  if (looksLikePan(id)) return undefined;
  if (!/[0-9]/.test(id)) return undefined;
  return id;
}

function extractPrice(result: string, task: string): number | undefined {
  const labeled = result.match(PRICE_LABEL);
  if (labeled?.[1]) {
    const n = parseRub(labeled[1]);
    if (n !== undefined) return n;
  }
  let last: number | undefined;
  for (const match of result.matchAll(PRICE_MARKED)) {
    const n = parseRub(match[1] ?? match[0]);
    if (n !== undefined) last = n;
  }
  if (last !== undefined) return last;
  const fromTask = task.match(TASK_PAID);
  if (fromTask?.[1]) return parseRub(fromTask[1]);
  return undefined;
}

function extractTitle(result: string, task: string): string | undefined {
  const labeled = result.match(TITLE_LABEL);
  if (labeled?.[1]) {
    const title = firstLine(labeled[1]);
    if (title) return title;
  }
  const quoted = result.match(/[«"]([^»"]{3,120})[»"]/);
  if (quoted?.[1]) {
    const title = clip(stripSecrets(quoted[1]), 200);
    if (title) return title;
  }
  const fromTask = clip(
    stripSecrets(task.replace(BUY_PREFIX, "").replace(SHOP_TAIL, "")),
    200,
  );
  if (fromTask.length >= 2 && !BUY_ONLY.test(fromTask)) return fromTask;
  return undefined;
}

function extractPickup(result: string): string | undefined {
  const m = result.match(PICKUP);
  if (!m?.[1]) return undefined;
  const pickup = firstLine(m[1]);
  return pickup.length > 0 ? clip(pickup, 280) : undefined;
}

export function parseOrderFromResult(args: ParseOrderArgs): ParsedOrder | null {
  const result = stripSecrets(args.result ?? "");
  const task = args.task ?? "";
  const blob = `${task}\n${result}`;
  const cancelled = CANCEL.test(blob);
  const failed = FAIL.test(result) && !cancelled;
  const orderId = extractOrderId(result);
  if (failed && !orderId) return null;

  const title = extractTitle(result, task);
  const priceRub = extractPrice(result, task);
  if (!title || priceRub === undefined) return null;

  const merchantOrderId = orderId ?? pendingOrderId(title, priceRub, args.now);
  const pickup = extractPickup(result);
  const status: OrderStatus = cancelled
    ? "cancelled"
    : orderId || SUCCESS.test(result)
      ? "placed"
      : "unknown";

  return {
    merchant: resolveMerchant(args),
    merchantOrderId,
    title,
    priceRub,
    status,
    ...(pickup ? { pickup } : {}),
  };
}

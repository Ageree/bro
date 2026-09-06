/**
 * Purchase stance: Bro pays when the person asked to buy, or when a
 * buy-when watcher fires. There is no second confirmation of shop / item /
 * qty / total. 3-D Secure, missing vault card, and a named budget ceiling
 * still stop the card.
 */

export type PurchaseStance = "search" | "buy" | "watch_and_buy";

const BUY =
  /(?:^|[^\p{L}])(?:купи(?:ть)?|закаж(?:и|ать)|оплати(?:ть)?|выкупи(?:ть)?|бери|возьми|оформи(?:ть)?\s+заказ)(?:[^\p{L}]|$)/iu;

const WATCH =
  /когда|как\s+только|если\s+(?:цена|будет|станет|появится)|подешев|дешевле|ниже\s+\d|будет\s+\d/iu;

/** Named ceiling: «до 3000», «дешевле 2500», «не дороже 2 000», «макс 4к». */
const BUDGET =
  /(?:до|дешевле|не\s+дороже|макс(?:имум)?|бюджет|не\s+выше|не\s+более|≤|<=)\s*(\d{1,3}(?:[\s\u00a0]?\d{3})+|\d+)(?:\s*(?:к|k))?(?:\s*(?:₽|руб(?:л(?:ей|я|ь))?))?/iu;

const THOUSANDS = /(?:^|[^\p{L}])(?:до|не\s+дороже|макс(?:имум)?|бюджет)\s*(\d+(?:[.,]\d+)?)\s*(?:к|k)(?:[^\p{L}]|$)/iu;

export function purchaseStance(text: string): PurchaseStance {
  const buy = BUY.test(text);
  const watch = WATCH.test(text);
  if (buy && watch) return "watch_and_buy";
  if (buy) return "buy";
  return "search";
}

function parseAmount(raw: string, asThousands: boolean): number | undefined {
  const compact = raw.replace(/[\s\u00a0]/g, "").replace(",", ".");
  const n = Number(compact);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const rub = asThousands ? Math.round(n * 1000) : Math.round(n);
  if (rub > 10_000_000) return undefined;
  return rub;
}

/** Budget the person named. Undefined = no ceiling, pay the listed total. */
export function budgetRub(text: string): number | undefined {
  const thousands = text.match(THOUSANDS);
  if (thousands?.[1]) {
    const n = parseAmount(thousands[1], true);
    if (n !== undefined) return n;
  }
  const m = text.match(BUDGET);
  if (!m?.[1]) return undefined;
  const usedK = /(?:к|k)\s*(?:₽|руб)?\s*$/i.test(m[0]);
  return parseAmount(m[1], usedK);
}

/** True when this watcher was a buy-when, not a notify-only price watch. */
export function watcherBuys(payload: string): boolean {
  return purchaseStance(payload) === "watch_and_buy";
}

/**
 * Whether a buy-when watcher should spend now. Unknown current price is left
 * to the agent (it must still check the live page); a known price above the
 * named ceiling must not pay.
 */
export function watcherShouldPay(opts: {
  payload: string;
  currentPriceRub?: number;
}): boolean {
  if (!watcherBuys(opts.payload)) return false;
  const cap = budgetRub(opts.payload);
  if (cap === undefined || opts.currentPriceRub === undefined) return true;
  return opts.currentPriceRub <= cap;
}

export function watcherWakeupPrompt(payload: string, lastSeen?: string): string {
  const buyLine = watcherBuys(payload)
    ? "Это сторож на покупку: если условие сработало (цена, наличие) — сразу `browser_task` с `pay`, не спрашивай подтверждение. maxRub — потолок из задания, если человек его назвал. Потом одно короткое сообщение, что купил. Если условие не сработало — [SILENT]."
    : "Если это только наблюдение (без «купи когда…») — сообщи об изменении, не покупай.";
  return `[background wakeup] Сторож: ${payload}.
Прошлое состояние: ${lastSeen ?? "ничего"}. Проверь текущее состояние (Composio-тулы или browser_task — что уместно). Если НИЧЕГО нового относительно прошлого состояния — ответь ровно [SILENT]. Если есть новое — одно короткое сообщение человеку. ${buyLine} В КОНЦЕ ответа добавь строку [SEEN] <краткое текущее состояние в одну строку> — она не уйдёт человеку.`;
}

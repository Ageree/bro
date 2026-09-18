/**
 * Purchase stance: Bro pays when the person asked to buy, or when a
 * buy-when watcher fires. There is no second confirmation of shop / item /
 * qty / total. 3-D Secure and a missing vault card still stop the card.
 *
 * A named budget ceiling does NOT stop the card, and this header used to say
 * it did. `maxRub` travels only into one Russian sentence in the cloud run's
 * prompt — «Сумма выше N ₽ — не плати» — which a third-party model may or may
 * not honour, and nothing in this repository ever compared it against what was
 * actually charged. A shipping fee added at checkout, a currency the page
 * quotes in, or a model that simply pays, all go through unnoticed.
 *
 * `overspend()` below is the part that can be enforced here: the run reports
 * what it paid, and a charge above the ceiling is reported to the person as an
 * overspend instead of a plain «готово». It is detection after the fact, not
 * prevention — prevention would have to live in the vendor — but it is the
 * difference between the person learning from us and learning from their bank.
 *
 * Lives in convex/lib (not agent/lib) because the Convex follow-through
 * bundle needs the same purchase rules the agent tools use, and Convex code
 * never imports from agent/. `agent/lib/purchase-policy.ts` re-exports this
 * module, so every existing import keeps working unchanged.
 */

export type PurchaseStance = "search" | "buy" | "watch_and_buy";

const BUY =
  /(?:^|[^\p{L}])(?:купи(?:ть)?|закаж(?:и|ать)|оплати(?:ть)?|выкупи(?:ть)?|бери|возьми|оформи(?:ть)?\s+заказ)(?:[^\p{L}]|$)/iu;

const WATCH =
  /когда|как\s+только|если\s+(?:цена|будет|станет|появится)|подешев|дешевле|ниже\s+\d|будет\s+\d/iu;

/** Named ceiling: «до 3000», «дешевле 2500», «не дороже 2 000», «макс 4к». */
const BUDGET =
  /(?:до|дешевле|не\s+дороже|макс(?:имум)?|бюджет|не\s+выше|не\s+более|≤|<=)\s*(\d{1,3}(?:[\s\u00a0]?\d{3})+|\d+)(?:\s*(?:к|k))?(?:\s*(?:₽|руб(?:л(?:ей|я|ь))?))?/iu;

const THOUSANDS = /(?:^|[^\p{L}])(?:до|не\s+дороже|макс(?:имум)?|бюджет)\s*(\d+(?:[.,]\d+)?)\s*(?:к|k|тыс\.?|тысяч|тысячи|тысяча)(?:\s*(?:рублей|₽))?(?:[^\p{L}]|$)/iu;

export function purchaseStance(text: string): PurchaseStance {
  const buy = BUY.test(text);
  const watch = WATCH.test(text);
  if (buy && watch) return "watch_and_buy";
  if (buy) return "buy";
  return "search";
}

export function parseAmount(raw: string, asThousands: boolean): number | undefined {
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

/**
 * What was charged against what the person allowed.
 *
 * Returns null when there is nothing to report: no ceiling was named, the run
 * reported no amount, or the charge is within the ceiling. A tolerance is
 * deliberately absent — the person said «до 5000», and 5001 is above 5000;
 * softening that here would be us deciding how much of their money a rounding
 * rule is worth.
 */
export function overspend(opts: {
  paidRub?: number;
  maxRub?: number;
}): { paidRub: number; maxRub: number; overRub: number } | null {
  const { paidRub, maxRub } = opts;
  if (paidRub === undefined || maxRub === undefined) return null;
  if (!Number.isFinite(paidRub) || !Number.isFinite(maxRub)) return null;
  if (paidRub <= maxRub) return null;
  return { paidRub, maxRub, overRub: paidRub - maxRub };
}

/** The line the model must pass on when a run spent more than it was allowed. */
export function overspendLine(over: {
  paidRub: number;
  maxRub: number;
}): string {
  return `списано ${over.paidRub} ₽ при потолке ${over.maxRub} ₽ — скажи это человеку первой строкой, не выдавай за обычное «готово»`;
}

export function watcherWakeupPrompt(payload: string, lastSeen?: string): string {
  // The ceiling is resolved here and stated as a number. The tool enforces it
  // either way (`watcherPayDecision` fills `maxRub` from this same payload),
  // but a model that has been told «потолок 3000 ₽» stops at the right price
  // on the page, which is hours earlier than a post-hoc «превышен потолок».
  const cap = watcherBuys(payload) ? budgetRub(payload) : undefined;
  const capLine =
    cap !== undefined
      ? ` Потолок ${cap} ₽: дороже не бери, лучше напиши человеку.`
      : " Потолка человек не называл — если цена заметно выше ожидаемой, сначала спроси.";
  const buyLine = watcherBuys(payload)
    ? `Это сторож на покупку: если условие сработало (цена, наличие) — сразу \`browser_task\` с \`pay\`, не спрашивай подтверждение.${capLine} Потом одно короткое сообщение, что купил. Если условие не сработало — [SILENT].`
    : "Это только наблюдение (без «купи когда…»): сообщи об изменении и не покупай — оплату по такому сторожу тул всё равно отклонит.";
  return `[background wakeup] Сторож: ${payload}.
Прошлое состояние: ${lastSeen ?? "ничего"}. Проверь текущее состояние (Composio-тулы или browser_task — что уместно). Если НИЧЕГО нового относительно прошлого состояния — ответь ровно [SILENT]. Если есть новое — одно короткое сообщение человеку. ${buyLine} В КОНЦЕ ответа добавь строку [SEEN] <краткое текущее состояние в одну строку> — она не уйдёт человеку.`;
}

/** The buy-verb half of the order-recording gate: a run whose task text asks
 *  for a purchase records an order even when it was not started with a bound
 *  card. Lives next to `purchaseStance` so both completion paths
 *  (`browser_task`'s settle and convex/browserFollow's poll) share one rule. */
export function taskLooksLikeBuy(task: string): boolean {
  const stance = purchaseStance(task);
  return stance === "buy" || stance === "watch_and_buy";
}

const ATTACH_CARD_RU =
  /(?:привяж|привязк|прикреп|подключ|добав|сохран|заведи|введи|укаж|настрой)\p{L}*\s+(?:(?:нов\p{L}+|мою|свою|эту|банковск\p{L}+|нашу)\s+){0,2}(?:карт\p{L}*|способ\p{L}*\s+оплат\p{L}*)/iu;

const ATTACH_CARD_RU_REVERSED =
  /карт\p{L}*\s+(?:привяж|привязк|прикреп|подключ|добав|сохран)\p{L}*/iu;

const ATTACH_CARD_EN =
  /\b(?:attach|add|save|link|bind|set\s+up)\s+(?:a\s+|my\s+|the\s+|new\s+|credit\s+|debit\s+|bank\s+)*(?:card|payment\s+method)\b/i;

/**
 * «привяжи карту» / «добавь способ оплаты» / "add a card" — a first-class
 * errand that binds the card and saves it, with no purchase at the end.
 * «оплати картой из сейфа» is NOT this: paying is a different shape.
 */
export function isAttachCardErrand(task: string | undefined | null): boolean {
  const text = (task ?? "").trim();
  if (!text) return false;
  return (
    ATTACH_CARD_RU.test(text) ||
    ATTACH_CARD_RU_REVERSED.test(text) ||
    ATTACH_CARD_EN.test(text)
  );
}

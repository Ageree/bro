import {
  budgetRub,
  purchaseStance,
  watcherBuys,
  watcherShouldPay,
  watcherWakeupPrompt,
} from "../agent/lib/purchase-policy.ts";
import { taskLooksLikeBuy } from "../agent/lib/browser-task-policy.ts";
import { isAttachCardErrand } from "../agent/lib/browser-pay.ts";
import { parseOrderFromResult } from "../agent/lib/order-policy.ts";

import { assert, src } from "./lib/check.ts";

assert(purchaseStance("найди кроссовки на WB") === "search", "search find");
assert(purchaseStance("сколько стоит эта зубная паста") === "search", "search price");
assert(purchaseStance("сравни ozon и wb") === "search", "search compare");
assert(purchaseStance("купи эти кроссовки 42") === "buy", "buy now");
assert(purchaseStance("закажи воду на ozon") === "buy", "order is buy");
assert(purchaseStance("оформи заказ на wb") === "buy", "оформи заказ");
assert(purchaseStance("оформи возврат") === "search", "return is not a buy");
assert(
  purchaseStance("купи когда будет дешевле 2500") === "watch_and_buy",
  "watch and buy",
);
assert(
  purchaseStance("как только появится — купи") === "watch_and_buy",
  "as soon as buy",
);
assert(
  purchaseStance("следи за ценой, купи если станет 1990") === "watch_and_buy",
  "buy if price",
);

assert(budgetRub("найди кроссовки") === undefined, "no budget");
assert(budgetRub("купи до 3000") === 3000, "до 3000");
assert(budgetRub("не дороже 2 000 ₽") === 2000, "spaced thousands");
assert(budgetRub("бюджет 1500 руб") === 1500, "бюджет");
assert(budgetRub("макс 4к") === 4000, "4к");
assert(budgetRub("до 3.5к") === 3500, "3.5к");
assert(budgetRub("не выше 990") === 990, "не выше");
assert(budgetRub("купи когда будет дешевле 2500") === 2500, "дешевле 2500");
assert(budgetRub("до 5 тысяч") === 5000, "до 5 тысяч");
assert(budgetRub("бюджет 3 тысячи") === 3000, "бюджет 3 тысячи");
assert(budgetRub("не дороже 5 тыс") === 5000, "не дороже 5 тыс");
assert(budgetRub("до 5 тыс. рублей") === 5000, "до 5 тыс. рублей");

assert(watcherBuys("пиши когда цена упадёт") === false, "notify-only");
assert(watcherBuys("купи когда будет дешевле 2500") === true, "buy watcher");
assert(
  watcherShouldPay({ payload: "пиши когда цена упадёт", currentPriceRub: 100 }) ===
    false,
  "notify watcher never pays",
);
assert(
  watcherShouldPay({
    payload: "купи когда будет дешевле 2500",
    currentPriceRub: 2400,
  }) === true,
  "under ceiling pays",
);
assert(
  watcherShouldPay({
    payload: "купи когда будет дешевле 2500",
    currentPriceRub: 2600,
  }) === false,
  "over ceiling does not pay",
);
assert(
  watcherShouldPay({ payload: "купи когда появится в наличии" }) === true,
  "no price yet — agent must check live",
);

const buyPrompt = watcherWakeupPrompt("купи когда будет дешевле 2500", "2800 ₽");
assert(buyPrompt.includes("сторож на покупку"), "buy watcher prompt");
assert(buyPrompt.includes("не спрашивай подтверждение"), "no confirm");
assert(buyPrompt.includes("[SEEN]"), "keeps SEEN marker");
assert(buyPrompt.includes("2800"), "lastSeen in prompt");

const watchPrompt = watcherWakeupPrompt("цена на wb");
assert(watchPrompt.includes("не покупай"), "notify watcher does not buy");
assert(!watchPrompt.includes("сторож на покупку"), "notify is not a buy watcher");

// --- A3 F5: browser_task's order-recording gate is not fooled by a paid
// non-"buy-verb" errand (e.g. a taxi ride paid with a bound card) ---
assert(taskLooksLikeBuy("купи кроссовки на wb"), "buy verb");
assert(!taskLooksLikeBuy("вызови такси до аэропорта"), "taxi has no buy verb by itself");
assert(
  src("agent/tools/browser_task.ts").includes("payingFor(extra, tenant)"),
  "maybeRecordOrder falls back to the tenant's persisted browserPaying, not just the verb",
);

// --- «привяжи карту» is a card errand, not a purchase: nothing is bought, so
// nothing may be written to `orders` (the bank's ~1 ₽ hold is not an order) ---
assert(isAttachCardErrand("привяжи карту в яндекс такси"), "attach-card errand");
assert(!taskLooksLikeBuy("привяжи карту в яндекс такси"), "attaching a card is not a buy");
assert(
  !isAttachCardErrand("купи кроссовки на wb"),
  "a real purchase is not an attach-card errand",
);
assert(
  src("convex/lib/orderRecordPolicy.ts").includes(
    "if (isAttachCardErrand(task) && !buy) return null;",
  ),
  "the shared order gate bails out on an attach-card run even though it is a paying run",
);
assert(
  src("agent/tools/browser_task.ts").includes("orderRowFromRun({"),
  "maybeRecordOrder goes through that gate",
);
{
  // Belt and braces: even if it reached the parser, a saved-card outcome has
  // no price, so no order row could be built from it.
  const row = parseOrderFromResult({
    task: "привяжи карту в яндекс такси",
    result: [
      "СДЕЛАНО: карта привязана в Яндекс Такси",
      "ЗАКАЗ: нет",
      "СУММА: нет",
      "КОГДА: нет",
      "ВАРИАНТЫ: нет",
      "НУЖНО: none",
      "ДЕТАЛИ: нет",
    ].join("\n"),
    hosts: ["yandex.ru"],
    pay: true,
  });
  assert(row === null, "a saved card never becomes an order row");
}

console.log("purchase-check ok");

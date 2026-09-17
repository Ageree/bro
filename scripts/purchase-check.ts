import {
  budgetRub,
  purchaseStance,
  watcherBuys,
  watcherShouldPay,
  watcherWakeupPrompt,
  overspend,
  overspendLine,
} from "../agent/lib/purchase-policy.ts";
import { taskLooksLikeBuy } from "../agent/lib/browser-task-policy.ts";
import { isAttachCardErrand } from "../agent/lib/browser-pay.ts";
import { parseOrderFromResult } from "../agent/lib/order-policy.ts";

import { assert, eq, src } from "./lib/check.ts";

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

// --- the named ceiling is checked in code, not only in the vendor's prompt ---
/**
 * `maxRub` used to travel into exactly one place: a Russian sentence in the
 * cloud run's prompt, «Сумма выше N ₽ — не плати». Nothing ever compared it
 * against what was actually charged, so a shipping fee added at checkout, a
 * page quoting another currency, or a model that simply paid, all went through
 * as an ordinary «готово» and the person found out from their bank.
 *
 * `overspend()` cannot prevent the charge — prevention would have to live in
 * the vendor — but it decides whether the person is told, which is the whole
 * difference between learning it from Bro and learning it from a bank SMS.
 */
{
  eq(overspend({ paidRub: 4900, maxRub: 5000 }), null, "inside the ceiling is silent");
  eq(overspend({ paidRub: 5000, maxRub: 5000 }), null, "exactly at the ceiling is allowed");
  eq(overspend({ paidRub: 100 }), null, "no ceiling named, nothing to report");
  eq(overspend({ maxRub: 100 }), null, "no amount reported, nothing to compare");
  eq(overspend({}), null, "neither side known");
  eq(
    overspend({ paidRub: Number.NaN, maxRub: 5000 }),
    null,
    "an unparsable amount is not an overspend claim",
  );

  const over = overspend({ paidRub: 7400, maxRub: 5000 });
  assert(over !== null, "a charge above the ceiling is reported");
  eq(over!.overRub, 2400, "the overspend is the difference, for the person to see");
  // One rouble over is over. Softening this here would be us deciding how much
  // of someone else's money a rounding rule is worth.
  assert(overspend({ paidRub: 5001, maxRub: 5000 }) !== null, "one rouble over is over");

  const line = overspendLine({ paidRub: 7400, maxRub: 5000 });
  assert(line.includes("7400") && line.includes("5000"), "the line carries both numbers");
  assert(/перв/i.test(line), "the line tells the model to lead with it");
}

// The wiring: the ceiling is persisted with the run and read back on completion.
{
  const tool = src("agent/tools/browser_task.ts");
  assert(tool.includes("browserMaxRub"), "the ceiling is stored with the run");
  assert(
    tool.includes("overspend(") && tool.includes("overspendLine("),
    "the completion path compares the charge against the ceiling",
  );
  assert(
    tool.includes("превышен_потолок"),
    "an overspend reaches the model under a name it cannot read past",
  );
  const schema = src("convex/schema.ts");
  assert(
    schema.includes("browserMaxRub"),
    "the follow-through path can see the ceiling too",
  );
}

console.log("purchase-check: ceiling verified in code");

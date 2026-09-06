import { readFileSync } from "node:fs";
import {
  merchantFromHost,
  merchantFromTask,
  parseOrderFromResult,
  pendingOrderId,
  resolveMerchant,
} from "../agent/lib/order-policy.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// --- merchant ---

assert(merchantFromHost("wildberries.ru") === "wb", "host wildberries.ru");
assert(merchantFromHost("https://www.wildberries.ru/checkout") === "wb", "host URL");
assert(merchantFromHost("www.wb.ru") === "wb", "host wb.ru");
assert(merchantFromHost("https://global.wildberries.ru/") === "wb", "host subdomain");
assert(merchantFromHost("ozon.ru") === "ozon", "host ozon.ru");
assert(merchantFromHost("https://www.ozon.ru/product/1") === "ozon", "host ozon URL");
assert(merchantFromHost("securepay.ozon.ru") === "ozon", "host ozon pay");
assert(merchantFromHost("lamoda.ru") === "other", "host other");
assert(merchantFromHost("amazon.com") === "other", "host amazon");

assert(merchantFromTask("купи кроссовки на wildberries") === "wb", "task wildberries");
assert(merchantFromTask("кроссовки на WB") === "wb", "task WB");
assert(merchantFromTask("найди на wb.ru") === "wb", "task wb.ru");
assert(merchantFromTask("закажи воду на вб") === "wb", "task вб");
assert(merchantFromTask("закажи воду на ozon") === "ozon", "task ozon");
assert(merchantFromTask("озон, 2 бутылки") === "ozon", "task озон");
assert(merchantFromTask("купи воду") === "other", "task no shop");

assert(
  resolveMerchant({
    task: "купи на wb",
    hosts: ["ozon.ru"],
  }) === "ozon",
  "hosts win over task",
);
assert(
  resolveMerchant({
    task: "купи воду",
    pay: { hosts: ["wildberries.ru"] },
  }) === "wb",
  "pay.hosts",
);

// --- parse: labeled WB confirmation ---

const placed = parseOrderFromResult({
  task: "купи кроссовки nike 42 на wb",
  result: `Заказ успешно оформлен.
Номер заказа: 15372849102
Товар: Кроссовки Nike Revolution 42
Сумма: 4 990 ₽
ПВЗ: Москва, ул. Тверская 7`,
  hosts: ["wildberries.ru"],
});
assert(placed, "placed row");
assert(placed.merchant === "wb", "placed merchant");
assert(placed.merchantOrderId === "15372849102", "placed id from result");
assert(placed.title.includes("Nike"), "placed title");
assert(placed.priceRub === 4990, "placed price");
assert(placed.status === "placed", "placed status");
assert(placed.pickup?.includes("Тверская"), "placed pickup");

// --- never invent a real id; pending hash when title+price only ---

const now = Date.parse("2026-09-06T12:00:00.000Z");
const pending = parseOrderFromResult({
  task: "купи кроссовки nike на wb",
  result: "Оплатил кроссовки Nike за 4990₽, жду ПВЗ",
  now,
});
assert(pending, "pending row");
assert(pending.merchantOrderId.startsWith("pending:"), "pending prefix");
assert(
  pending.merchantOrderId === pendingOrderId(pending.title, pending.priceRub, now),
  "pending hash stable",
);
assert(pending.priceRub === 4990, "pending price");
assert(pending.status === "placed", "оплатил → placed");
assert(
  parseOrderFromResult({
    task: "купи кроссовки nike на wb",
    result: "Оплатил кроссовки Nike за 4990₽, жду ПВЗ",
    now,
  })?.merchantOrderId === pending.merchantOrderId,
  "same day same pending id",
);
assert(
  parseOrderFromResult({
    task: "купи кроссовки nike на wb",
    result: "Оплатил кроссовки Nike за 4990₽, жду ПВЗ",
    now: Date.parse("2026-09-07T12:00:00.000Z"),
  })?.merchantOrderId !== pending.merchantOrderId,
  "next day new pending id",
);

const noIdNoPrice = parseOrderFromResult({
  task: "купи кроссовки",
  result: "ещё ищу варианты",
});
assert(noIdNoPrice === null, "skip without title+price");

const priceOnly = parseOrderFromResult({
  task: "купи",
  result: "нашёл за 1990₽",
});
assert(priceOnly === null, "skip price without title");

// --- cancel ---

const cancelled = parseOrderFromResult({
  task: "отмени заказ",
  result: "Заказ 15372849102 отменён. Товар: Кроссовки Nike. Сумма: 4990₽",
});
assert(cancelled?.status === "cancelled", "cancel phrases → cancelled");
assert(cancelled?.merchantOrderId === "15372849102", "cancel keeps real id");

// --- failed checkout is not an order ---

assert(
  parseOrderFromResult({
    task: "купи кроссовки nike на wb",
    result: "Не удалось оплатить. Кроссовки Nike, 4990₽",
  }) === null,
  "failed pay without id → skip",
);

// --- card numbers never become the order id or title ---

const withCard = parseOrderFromResult({
  task: "купи кроссовки на ozon",
  result:
    "Оплатил картой 4111111111111111. Номер заказа: 99887766. Товар: Вода 19л. Сумма: 390₽",
});
assert(withCard, "card result still parses");
assert(withCard.merchantOrderId === "99887766", "id is not the PAN");
assert(!withCard.title.includes("4111"), "title has no card");
assert(!JSON.stringify(withCard).includes("4111111111111111"), "row has no PAN");
assert(withCard.merchant === "ozon", "ozon from task");

assert(
  parseOrderFromResult({
    task: "купи воду",
    result: "Номер заказа: 4111111111111111 Товар: Вода Сумма: 390₽",
  })?.merchantOrderId.startsWith("pending:") === true,
  "PAN labeled as order id is ignored",
);

// --- wiring ---

const ordersSrc = readFileSync(new URL("../convex/orders.ts", import.meta.url), "utf8");
assert(ordersSrc.includes("assertSecret"), "orders assertSecret");
assert(ordersSrc.includes("listForPhone"), "listForPhone");
assert(ordersSrc.includes("updateStatus"), "updateStatus");
assert(ordersSrc.includes("createdAt: Date.now()"), "record sets createdAt");
assert(ordersSrc.includes("pickup"), "record pickup");
assert(ordersSrc.includes(".take(20)"), "listForPhone last 20");
assert(ordersSrc.includes("phoneE164"), "phone-gated queries");
assert(!ordersSrc.includes("v.any()"), "no any in orders.ts");

const convexSrc = readFileSync(new URL("../agent/lib/convex.ts", import.meta.url), "utf8");
assert(convexSrc.includes("export async function recordOrder"), "recordOrder wrapper");
assert(convexSrc.includes("export async function listOrders"), "listOrders wrapper");
assert(convexSrc.includes("export async function updateOrderStatus"), "updateOrderStatus wrapper");
assert(convexSrc.includes("api.orders.listForPhone"), "listOrders hits listForPhone");
assert(convexSrc.includes("api.orders.updateStatus"), "update hits updateStatus");

const settleSrc = readFileSync(
  new URL("../agent/tools/browser_task.ts", import.meta.url),
  "utf8",
);
assert(settleSrc.includes("parseOrderFromResult"), "settle parses result");
assert(settleSrc.includes("recordOrder"), "settle records");
assert(settleSrc.includes("extra.paying"), "settle checks paying");
assert(settleSrc.includes("purchaseStance"), "settle uses buy stance");
assert(settleSrc.includes("record order failed"), "settle swallows record errors");
assert(settleSrc.includes("maybeRecordOrder"), "record does not replace payload");

const toolSrc = readFileSync(new URL("../agent/tools/list_orders.ts", import.meta.url), "utf8");
assert(toolSrc.includes("list_orders") || toolSrc.includes("Заказы"), "tool voice");
assert(toolSrc.includes("cancel"), "tool can cancel");
assert(toolSrc.includes("listOrders"), "tool lists");
assert(toolSrc.includes("updateOrderStatus"), "tool updates");
assert(
  /карт|CVV|сейф/i.test(toolSrc) && /никогда|не выводи/i.test(toolSrc),
  "tool forbids dumping cards",
);
assert(!toolSrc.includes("v.any()"), "no any in list_orders");

const instr = readFileSync(new URL("../agent/instructions.md", import.meta.url), "utf8");
assert(instr.includes("list_orders"), "instructions name list_orders");
assert(instr.includes("Где заказ") || instr.includes("где заказ"), "instructions где заказ");
assert(instr.includes("ПВЗ"), "instructions ПВЗ");
assert(
  instr.includes("строки нет") || instr.includes("таблице уже есть"),
  "browser only if no row",
);

const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
assert(pkg.includes("orders:check"), "package.json orders:check");

const schemaSrc = readFileSync(new URL("../convex/schema.ts", import.meta.url), "utf8");
assert(schemaSrc.includes("orders:"), "schema still has orders");
assert(schemaSrc.includes('v.literal("wb")'), "schema merchant wb");
assert(schemaSrc.includes("pickup"), "schema pickup");

console.log("orders-check ok");

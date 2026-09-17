import { readdirSync } from "node:fs";

// Imported through the agent-side re-export on purpose: it must keep working
// unchanged now that the parser itself lives in convex/lib.
import {
  merchantFromHost,
  merchantFromTask,
  parseOrderFromResult,
  pendingOrderId,
  resolveMerchant,
  type ParsedOrder,
} from "../agent/lib/order-policy.ts";
import { orderRowFromRun } from "../convex/lib/orderRecordPolicy.ts";

import { assert, eq, src } from "./lib/check.ts";

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

// --- А2: labelled («НУЖНО» protocol) result wins over free-text guessing ---

const labelledPlaced = parseOrderFromResult({
  task: "купи кроссовки nike 42 на wb",
  result: `СДЕЛАНО: Заказал кроссовки Nike Revolution 42
ЗАКАЗ: 15372849102
СУММА: 4990
КОГДА: нет
ВАРИАНТЫ: нет
НУЖНО: none
ДЕТАЛИ: нет`,
  hosts: ["wildberries.ru"],
});
assert(labelledPlaced, "labelled row");
assert(labelledPlaced.merchantOrderId === "15372849102", "labelled id");
assert(labelledPlaced.title.includes("Nike"), "labelled title from СДЕЛАНО");
assert(labelledPlaced.priceRub === 4990, "labelled price from СУММА");
assert(labelledPlaced.status === "placed", "labelled needs:none → placed");

const labelledNeed = parseOrderFromResult({
  task: "купи кроссовки nike на wb",
  result: `СДЕЛАНО: нет
ЗАКАЗ: нет
СУММА: нет
КОГДА: нет
ВАРИАНТЫ: нет
НУЖНО: sms_code
ДЕТАЛИ: нет`,
});
assert(labelledNeed === null, "labelled result with a pending need is not an order yet");

// ---------------------------------------------------------------------------
// The background completion path: a run that finishes while nobody is in a
// model turn is recorded from convex/browserFollow.ts through the very same
// gate the `browser_task` tool uses (`orderRowFromRun`). Before this, only
// the tool wrote rows, so a purchase that completed in the background was
// never in `orders` and «где мой заказ» found nothing.
// ---------------------------------------------------------------------------

/** convex/orders.ts `record`, in miniature: an upsert keyed on
 *  (tenantId, merchantOrderId). Both completion paths write through it. */
function makeOrdersTable() {
  const rows = new Map<string, { id: string; row: ParsedOrder }>();
  let seq = 0;
  return {
    record(tenantId: string, row: ParsedOrder): string {
      const key = `${tenantId}|${row.merchantOrderId}`;
      const existing = rows.get(key);
      if (existing) {
        existing.row = row;
        return existing.id;
      }
      const id = `order_${++seq}`;
      rows.set(key, { id, row });
      return id;
    },
    get all() {
      return [...rows.values()];
    },
  };
}

const PAID_BACKGROUND = {
  status: "completed",
  task: "купи кроссовки nike 42 на wb",
  result: [
    "СДЕЛАНО: Заказал кроссовки Nike Revolution 42",
    "ЗАКАЗ: 15372849102",
    "СУММА: 4990",
    "КОГДА: нет",
    "ВАРИАНТЫ: нет",
    "НУЖНО: none",
    "ДЕТАЛИ: нет",
  ].join("\n"),
  paying: true,
  hosts: ["wildberries.ru"],
} as const;

// 1. A paid run that completes in the background records exactly one row.
{
  const table = makeOrdersTable();
  const row = orderRowFromRun({ ...PAID_BACKGROUND });
  assert(row, "a paid background completion is an order row");
  table.record("tenant_1", row);
  eq(table.all.length, 1, "exactly one row for one background completion");
  eq(table.all[0]!.row.merchantOrderId, "15372849102", "row keeps the merchant order id");
  eq(table.all[0]!.row.priceRub, 4990, "row keeps the price");
  eq(table.all[0]!.row.status, "placed", "background completion is placed");
  eq(table.all[0]!.row.merchant, "wb", "merchant from the run's pay hosts");
}

// 2. Both paths recording the same run leave one row with the same id: the
//    upsert is keyed on (tenantId, merchantOrderId) and the parse is
//    deterministic, which is why no second dedupe is needed.
{
  const table = makeOrdersTable();
  // the Convex poll (tenant.browserPaying / tenant.browserPayHosts)
  const fromPoll = orderRowFromRun({ ...PAID_BACKGROUND });
  // the tool's settle() for the very same run (extra.paying / extra.payHosts)
  const fromTool = orderRowFromRun({ ...PAID_BACKGROUND });
  assert(fromPoll && fromTool, "both paths build a row");
  eq(fromPoll.merchantOrderId, fromTool.merchantOrderId, "same run, same key");
  const first = table.record("tenant_1", fromPoll);
  const second = table.record("tenant_1", fromTool);
  eq(table.all.length, 1, "recording twice leaves one row");
  eq(first, second, "recording twice returns the same order id");
}

// 3. An attach-card run records nothing — the bank's ~1 ₽ hold is not a buy.
{
  const table = makeOrdersTable();
  const row = orderRowFromRun({
    status: "completed",
    task: "привяжи карту в яндекс такси",
    result: [
      "СДЕЛАНО: карта привязана, списали 1 ₽ и вернули",
      "ЗАКАЗ: 77001",
      "СУММА: 1",
      "КОГДА: нет",
      "ВАРИАНТЫ: нет",
      "НУЖНО: none",
      "ДЕТАЛИ: нет",
    ].join("\n"),
    paying: true,
    hosts: ["taxi.yandex.ru"],
  });
  assert(row === null, "an attach-card run is never an order");
  if (row) table.record("tenant_1", row);
  eq(table.all.length, 0, "attach-card records nothing");
}

// 4. A run parked on a «НУЖНО» records nothing, even with a price on screen.
{
  const row = orderRowFromRun({
    status: "completed",
    task: "купи кроссовки nike на wb",
    result: [
      "СДЕЛАНО: нет",
      "ЗАКАЗ: нет",
      "СУММА: 4990",
      "КОГДА: нет",
      "ВАРИАНТЫ: нет",
      "НУЖНО: 3ds",
      "ДЕТАЛИ: пришлите код из банка",
    ].join("\n"),
    paying: true,
    hosts: ["wildberries.ru"],
  });
  assert(row === null, "a run still waiting on the human is not an order");
}

// 5. A non-paying, non-buy errand records nothing, however shop-like it reads.
{
  const row = orderRowFromRun({
    status: "completed",
    task: "посмотри цену кроссовок nike на wb",
    result: "Нашёл: Кроссовки Nike Revolution 42. Сумма: 4990 ₽. Номер заказа: 15372849102",
    paying: false,
  });
  assert(row === null, "a look-only errand is not an order");
}

// 6. An unlabelled result with no order number behaves exactly as the tool
//    path does today: a stable `pending:` id built from title+price.
{
  const at = Date.parse("2026-09-16T09:00:00.000Z");
  const row = orderRowFromRun({
    status: "completed",
    task: "купи кроссовки nike на wb",
    result: "Оплатил кроссовки Nike за 4990₽, жду ПВЗ",
    paying: true,
    now: at,
  });
  assert(row, "an unlabelled paid result is still an order");
  eq(
    row.merchantOrderId,
    pendingOrderId(row.title, row.priceRub, at),
    "unlabelled result gets the same pending id the tool path builds",
  );
  eq(
    row.merchantOrderId,
    parseOrderFromResult({
      task: "купи кроссовки nike на wb",
      result: "Оплатил кроссовки Nike за 4990₽, жду ПВЗ",
      pay: true,
      now: at,
    })?.merchantOrderId,
    "the gate and the bare parser agree on the id",
  );
  // ...and a second recording of it still lands on one row.
  const table = makeOrdersTable();
  const first = table.record("tenant_1", row);
  const second = table.record("tenant_1", { ...row });
  eq(table.all.length, 1, "pending-id row is upserted, not duplicated");
  eq(first, second, "pending-id row keeps its id");
}

// 7. A run that is not finished yet is never an order.
{
  assert(
    orderRowFromRun({ ...PAID_BACKGROUND, status: "running" }) === null,
    "a still-running run is not an order",
  );
  assert(
    orderRowFromRun({ ...PAID_BACKGROUND, status: "failed" }) === null,
    "a failed run is not an order",
  );
}

// --- the background path is actually wired up ---

const followSrc = src("convex/browserFollow.ts");
assert(
  followSrc.includes("async function recordOrderFromRun"),
  "convex/browserFollow.ts records orders itself",
);
assert(
  followSrc.includes("orderRowFromRun({"),
  "the Convex path gates through the same orderRowFromRun as the tool",
);
assert(
  followSrc.includes("api.orders.record"),
  "the Convex path writes through the idempotent orders.record upsert",
);
{
  const pollFn = followSrc.slice(
    followSrc.indexOf("export const pollRun"),
    followSrc.indexOf("const lateResultReturn"),
  );
  assert(
    pollFn.includes("recordOrderFromRun(ctx"),
    "pollRun records the finished run — the background completion path",
  );
  assert(
    pollFn.indexOf("recordOrderFromRun(ctx") < pollFn.indexOf("deliverDoneNow(ctx"),
    "the row is written before the human is told, so a failed delivery cannot lose it",
  );
  const lateFn = followSrc.slice(followSrc.indexOf("export const lateResultNotify"));
  assert(
    lateFn.includes("recordOrderFromRun(ctx"),
    "a run that finishes after polling stopped is recorded too",
  );
  assert(
    lateFn.indexOf("recordOrderFromRun(ctx") < lateFn.indexOf("api.wakeups.takeDelivery"),
    "lateResultNotify records before the delivery dedupe can return early",
  );
}

// --- the import boundary: convex/ bundles on its own and never reaches into
//     agent/, which is why the parser and the gate live under convex/lib ---
{
  const files = [
    ...readdirSync(new URL("../convex/", import.meta.url), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => `convex/${e.name}`),
    ...readdirSync(new URL("../convex/lib/", import.meta.url), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => `convex/lib/${e.name}`),
  ];
  assert(files.includes("convex/lib/orderPolicy.ts"), "the parser lives under convex/lib");
  assert(
    files.includes("convex/lib/purchasePolicy.ts") &&
      files.includes("convex/lib/orderRecordPolicy.ts"),
    "the purchase rules and the record gate live under convex/lib",
  );
  for (const rel of files) {
    for (const m of src(rel).matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      const spec = m[1]!;
      assert(
        !/(^|\/)agent\//.test(spec),
        `${rel} imports from agent/ (${spec}) — convex deploys as its own bundle`,
      );
    }
  }
}

// --- the agent-side modules still re-export their old surface ---
assert(
  src("agent/lib/order-policy.ts").includes('export * from "../../convex/lib/orderPolicy.ts";'),
  "agent/lib/order-policy.ts re-exports the moved parser",
);
assert(
  src("agent/lib/purchase-policy.ts").includes(
    'export * from "../../convex/lib/purchasePolicy.ts";',
  ),
  "agent/lib/purchase-policy.ts re-exports the moved purchase rules",
);

// --- wiring ---

const ordersSrc = src("convex/orders.ts");
assert(ordersSrc.includes("assertSecret"), "orders assertSecret");
assert(ordersSrc.includes("listForPhone"), "listForPhone");
assert(ordersSrc.includes("updateStatus"), "updateStatus");
assert(ordersSrc.includes("createdAt: Date.now()"), "record sets createdAt");
assert(ordersSrc.includes("pickup"), "record pickup");
assert(ordersSrc.includes(".take(20)"), "listForPhone last 20");
assert(ordersSrc.includes("phoneE164"), "phone-gated queries");
assert(
  ordersSrc.includes("by_tenant_and_merchant_order"),
  "record upserts by merchant order",
);
assert(ordersSrc.includes("ctx.db.patch"), "existing order is patched");
assert(!ordersSrc.includes("v.any()"), "no any in orders.ts");

const convexSrc = src("agent/lib/convex.ts");
assert(convexSrc.includes("export async function recordOrder"), "recordOrder wrapper");
assert(convexSrc.includes("export async function listOrders"), "listOrders wrapper");
assert(convexSrc.includes("export async function updateOrderStatus"), "updateOrderStatus wrapper");
assert(convexSrc.includes("api.orders.listForPhone"), "listOrders hits listForPhone");
assert(convexSrc.includes("api.orders.updateStatus"), "update hits updateStatus");

const settleSrc = src("agent/tools/browser_task.ts");
// The parse and the gate moved into `orderRowFromRun`
// (convex/lib/orderRecordPolicy.ts) so the background path can reuse both —
// settle() still records, now through that one function. The behaviour of
// each guard is exercised in the section above, not grepped for here.
assert(settleSrc.includes("orderRowFromRun({"), "settle parses result via the shared gate");
assert(
  src("convex/lib/orderRecordPolicy.ts").includes("parseOrderFromResult({"),
  "the shared gate is backed by parseOrderFromResult",
);
assert(
  src("convex/lib/purchasePolicy.ts").includes("purchaseStance(task)"),
  "taskLooksLikeBuy is backed by purchaseStance",
);
assert(settleSrc.includes("recordOrder"), "settle records");
assert(settleSrc.includes("extra.paying"), "settle checks paying");
assert(settleSrc.includes("record order failed"), "settle swallows record errors");
assert(settleSrc.includes("maybeRecordOrder"), "record does not replace payload");
assert(
  !/if \(extra\.reused === true\) return/.test(settleSrc),
  "follow-through reuse still records",
);

const toolSrc = src("agent/tools/list_orders.ts");
assert(toolSrc.includes("list_orders") || toolSrc.includes("Заказы"), "tool voice");
assert(toolSrc.includes("cancel"), "tool can cancel");
assert(toolSrc.includes("listOrders"), "tool lists");
assert(toolSrc.includes("updateOrderStatus"), "tool updates");
assert(
  /карт|CVV|сейф/i.test(toolSrc) && /никогда|не выводи/i.test(toolSrc),
  "tool forbids dumping cards",
);
assert(!toolSrc.includes("v.any()"), "no any in list_orders");

const instr = src("agent/instructions.md");
assert(instr.includes("list_orders"), "instructions name list_orders");
assert(instr.includes("Где заказ") || instr.includes("где заказ"), "instructions где заказ");
assert(instr.includes("ПВЗ"), "instructions ПВЗ");
assert(
  instr.includes("строки нет") || instr.includes("таблице уже есть"),
  "browser only if no row",
);

const pkg = src("package.json");
assert(pkg.includes("orders:check"), "package.json orders:check");

const schemaSrc = src("convex/schema.ts");
assert(schemaSrc.includes("orders:"), "schema still has orders");
assert(schemaSrc.includes('v.literal("wb")'), "schema merchant wb");
assert(schemaSrc.includes("pickup"), "schema pickup");
assert(
  schemaSrc.includes("by_tenant_and_merchant_order"),
  "schema index tenant+merchantOrderId",
);

console.log("orders-check ok");

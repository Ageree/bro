import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { listOrders } from "@db/services/orders";

type OrderRow = Awaited<ReturnType<typeof listOrders>>[number];

type OrderItem = NonNullable<OrderRow["items"]>[number];

const merchantNames = {
  ozon: "Ozon",
  wb: "Wildberries",
} as const;

const statusNames = {
  cancelled: "отменён",
  placed: "оформлен",
  unknown: "статус неизвестен",
} as const;

/** One basket line as the person would read it: name — price × quantity. */
function itemLine(item: OrderItem) {
  const cost = [item.price, item.quantity ? `× ${item.quantity}` : undefined]
    .filter((part) => part !== undefined)
    .join(" ");
  return cost.length > 0 ? `${item.name} — ${cost}` : item.name;
}

/** The bare host of the site an errand ran on: «lavka.yandex.ru». */
function siteHost(site: string | null) {
  const host = site === null ? undefined : URL.parse(site)?.hostname;
  const bare = host?.replace(/^www\./u, "");
  return bare === undefined || bare === "" ? undefined : bare;
}

/**
 * The shop, as the person would name it. Ozon and Wildberries have a name
 * of their own; any other shop is the site its errand ran on, or where the
 * card said it goes. «Другой магазин» told the person nothing (EN D4).
 */
function merchantName(row: OrderRow) {
  if (row.merchant !== "other") return merchantNames[row.merchant];
  return siteHost(row.site) ?? row.where ?? "магазин не записан";
}

export const listOrdersTool = defineTool({
  description:
    "Заказы, которые ты уже оформил этому человеку через браузерные поручения, — только они, а не вся история его покупок на сайте. «Где заказ», «что я заказывал», «когда забирать» — сначала сюда, а не в новый заход на сайт. Возвращает последние заказы с магазином (`merchant` и сайт поручения `site`), тем, что человек поручил и подтвердил (`errand`), номером, суммой, статусом, пунктом выдачи и составом, если запуск его сообщил. «Закажи то же, что в прошлый раз», а здесь такого заказа нет, — не повод спрашивать человека, что именно: заведи browser_task на этом сайте, и запуск найдёт покупку в истории заказов его аккаунта.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("How many of the most recent orders to return. Default 10."),
  }),
  async execute(input, context) {
    const auth = context.session.auth.current ?? context.session.auth.initiator;
    if (auth?.principalType !== "user") {
      throw new Error("An authenticated user is required to list orders.");
    }
    const rows = await listOrders(scopeFromPrincipal(auth), input.limit ?? 10);
    return {
      orders: rows.map((row) => ({
        errand: row.errand ?? undefined,
        items: row.items?.map(itemLine),
        merchant: merchantName(row),
        orderId: row.merchantOrderId,
        pickup: row.pickup ?? undefined,
        placedAt: row.createdAt.toISOString(),
        site: siteHost(row.site),
        status: statusNames[row.status],
        title: row.title,
        total: `${String(row.priceRub)} ₽`,
      })),
    };
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: { list_orders: listOrdersTool },
      }),
  },
});

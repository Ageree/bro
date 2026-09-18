import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { listOrders } from "@db/services/orders";

const merchantNames = {
  other: "другой магазин",
  ozon: "Ozon",
  wb: "Wildberries",
} as const;

const statusNames = {
  cancelled: "отменён",
  placed: "оформлен",
  unknown: "статус неизвестен",
} as const;

export const listOrdersTool = defineTool({
  description:
    "Заказы, которые ты уже оформил этому человеку через браузерные поручения. «Где заказ», «что я заказывал», «когда забирать» — сначала сюда, а не в новый заход на сайт. Возвращает последние заказы с номером, суммой, статусом и пунктом выдачи.",
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
        merchant: merchantNames[row.merchant],
        orderId: row.merchantOrderId,
        pickup: row.pickup ?? undefined,
        placedAt: row.createdAt.toISOString(),
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

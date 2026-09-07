import { defineTool } from "eve/tools";
import { z } from "zod";
import { listOrders, updateOrderStatus } from "../lib/convex";
import { tenantId } from "../lib/tenant";

type ListedOrder = {
  id: string;
  merchant: string;
  merchantOrderId: string;
  title: string;
  priceRub: number;
  status: string;
  pickup?: string;
  createdAt?: number;
};

function publicOrder(row: {
  _id: string;
  merchant: string;
  merchantOrderId: string;
  title: string;
  priceRub: number;
  status: string;
  pickup?: string;
  createdAt?: number;
}): ListedOrder {
  return {
    id: row._id,
    merchant: row.merchant,
    merchantOrderId: row.merchantOrderId,
    title: row.title,
    priceRub: row.priceRub,
    status: row.status,
    ...(row.pickup ? { pickup: row.pickup } : {}),
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
  };
}

export default defineTool({
  description:
    "Заказы этого человека из таблицы Bro — не свежий скрейп WB/Ozon. «Где заказ», «когда ПВЗ», «что с заказом» — сначала list. Отмена («отмени») — cancel по merchantOrderId или id строки. Номер карты, CVV и содержимое сейфа никогда не выводи и не проси.",
  inputSchema: z.object({
    action: z.enum(["list", "cancel"]).optional(),
    merchantOrderId: z.string().min(1).max(200).optional(),
    orderId: z.string().min(1).max(200).optional(),
  }),
  async execute({ action, merchantOrderId, orderId }, ctx) {
    const phone = tenantId(ctx);
    const mode =
      action ?? (merchantOrderId || orderId ? "cancel" : "list");
    if (mode === "cancel") {
      if (!merchantOrderId && !orderId) {
        return { error: "нужен merchantOrderId или orderId" };
      }
      const updated = await updateOrderStatus(phone, {
        status: "cancelled",
        merchantOrderId,
        orderId,
      });
      if ("error" in updated) return updated;
      return publicOrder(updated);
    }
    const rows = await listOrders(phone);
    return { orders: rows.map(publicOrder) };
  },
});

import { z } from "zod";
import {
  extendPaidUntil,
  paidPeriodDays,
  recordPayment,
} from "@db/services/billing";
import { readWorkspaceScope } from "@db/services/scope";
import {
  paymentAmountRub,
  readYooKassaPayment,
  yooKassaConfigured,
} from "@db/services/yookassa";

export const runtime = "nodejs";

// The only thing this endpoint reads from the delivery. Everything that
// decides money — status, amount, which workspace — comes from the re-fetch,
// because anyone on the internet can POST this shape.
const notificationSchema = z.object({
  object: z.object({ id: z.string().min(1) }),
});

/**
 * YooKassa's payment notification. It answers 200 for every delivery it
 * understands, including one about a payment it cannot place, so YooKassa
 * stops retrying; only a body that is not a notification at all is a 400.
 */
export async function POST(request: Request) {
  const notification = notificationSchema.safeParse(
    await request.json().catch(() => undefined)
  );
  if (!notification.success) {
    return Response.json({ message: "Unrecognised body." }, { status: 400 });
  }
  if (!yooKassaConfigured()) {
    return Response.json(
      { message: "Billing is not configured." },
      { status: 503 }
    );
  }

  const payment = await readYooKassaPayment(
    notification.data.object.id,
    request.signal
  );
  if (!payment) return Response.json({ applied: false });

  const currency = payment.amount?.currency;
  if (currency !== undefined && currency.toUpperCase() !== "RUB") {
    console.warn("[yookassa] ignoring a payment in another currency", {
      currency,
      paymentId: payment.id,
    });
    return Response.json({ applied: false });
  }

  const workspaceId = payment.metadata?.workspaceId;
  const scope = workspaceId ? await readWorkspaceScope(workspaceId) : null;
  if (!scope) return Response.json({ applied: false });

  if (payment.status !== "succeeded") {
    await recordPayment(scope, {
      amountRub: paymentAmountRub(payment),
      id: payment.id,
      status: payment.status === "canceled" ? "canceled" : "pending",
    });
    return Response.json({ applied: false });
  }

  const extended = await extendPaidUntil(scope, payment.id, paidPeriodDays);
  await recordPayment(scope, {
    amountRub: paymentAmountRub(payment),
    id: payment.id,
    status: "succeeded",
  });
  return Response.json({
    applied: extended.applied,
    paidUntil: extended.paidUntil?.toISOString() ?? null,
  });
}

import {
  requireRequestScope,
  UnauthenticatedError,
} from "@web/auth/request-scope";
import { recordPayment } from "@db/services/billing";
import {
  createYooKassaPayment,
  paymentAmountRub,
  yooKassaConfigured,
} from "@db/services/yookassa";
import { applicationOrigin } from "@shared/environment/origin";

export const runtime = "nodejs";

/**
 * Starts a checkout for the signed-in workspace and hands the browser to
 * YooKassa. The payment row exists before the redirect, so the webhook that
 * follows has something to reconcile even if the person never comes back.
 */
export async function GET(request: Request) {
  if (!yooKassaConfigured()) {
    return Response.json(
      { message: "Оплата на этом деплое не подключена." },
      { status: 503 }
    );
  }

  const scope = await signedInScope();
  if (!scope) {
    return Response.json(
      { message: "Сначала войди в кабинет." },
      { status: 401 }
    );
  }

  const { confirmationUrl, payment } = await createYooKassaPayment(
    scope.workspaceId,
    new URL("/workspace?paid=1", applicationOrigin()).toString(),
    request.signal
  );
  // Always `pending` here. Only the webhook's own re-fetch may move a payment
  // to `succeeded`, and only that transition grants paid access.
  await recordPayment(scope, {
    amountRub: paymentAmountRub(payment),
    id: payment.id,
    status: "pending",
  });

  return Response.redirect(confirmationUrl, 303);
}

/**
 * The proxy already sends a signed-out browser to the sign-in page, so this
 * only answers a request that reached the handler without one — a direct call.
 */
async function signedInScope() {
  try {
    return await requireRequestScope();
  } catch (error) {
    if (error instanceof UnauthenticatedError) return undefined;
    throw error;
  }
}

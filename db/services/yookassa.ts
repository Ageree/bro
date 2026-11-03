import { randomUUID } from "node:crypto";
import * as z from "zod";
import { env } from "@shared/environment";
import { cardPriceRub } from "@shared/billing/price";

const yooKassaBaseUrl = "https://api.yookassa.ru/v3/payments";
const requestTimeoutMs = 20_000;

/**
 * Both credentials together switch billing on. Without them the deployment
 * runs in free mode: free limits apply and nothing offers a pay link, which is
 * the honest state rather than a broken checkout.
 */
export function yooKassaConfigured() {
  return (
    env.YOOKASSA_SHOP_ID !== undefined && env.YOOKASSA_SECRET_KEY !== undefined
  );
}

function credentials() {
  const shopId = env.YOOKASSA_SHOP_ID;
  const secretKey = env.YOOKASSA_SECRET_KEY;
  if (!shopId || !secretKey) {
    throw new Error(
      "YooKassa is not configured for this deployment. Set YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY."
    );
  }
  return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString("base64")}`;
}

// Only the fields this application acts on. Everything else YooKassa sends
// stays out: a payment is applied from its status, amount and metadata, and a
// field nobody reads is a field nobody has to keep trusting.
const paymentSchema = z.object({
  amount: z.object({ currency: z.string(), value: z.string() }).optional(),
  confirmation: z
    .object({ confirmation_url: z.string().optional() })
    .optional(),
  id: z.string().min(1),
  metadata: z.object({ workspaceId: z.string().optional() }).optional(),
  status: z.enum(["pending", "waiting_for_capture", "succeeded", "canceled"]),
});

export type YooKassaPayment = z.infer<typeof paymentSchema>;

/** Whole roubles, or the configured price when YooKassa sent no amount. */
export function paymentAmountRub(payment: YooKassaPayment) {
  const parsed = Number.parseFloat(payment.amount?.value ?? "");
  return Number.isFinite(parsed) ? Math.round(parsed) : env.PRICE_RUB;
}

/** How the person pays: SBP at the base price, or a bank card at its own price. */
export type PaymentMethod = "sbp" | "card";

export async function createYooKassaPayment(
  workspaceId: string,
  returnUrl: string,
  method: PaymentMethod,
  signal?: AbortSignal
) {
  const amountRub = method === "card" ? cardPriceRub() : env.PRICE_RUB;
  const response = await fetch(yooKassaBaseUrl, {
    body: JSON.stringify({
      amount: { currency: "RUB", value: `${String(amountRub)}.00` },
      capture: true,
      confirmation: { return_url: returnUrl, type: "redirect" },
      description: "Бро — месяц доступа",
      // Opens the chosen method only, so the card price cannot be paid by SBP
      // and the other way round.
      payment_method_data: {
        type: method === "card" ? "bank_card" : "sbp",
      },
      metadata: { method, workspaceId },
    }),
    headers: {
      Authorization: credentials(),
      "Content-Type": "application/json",
      // A retried create must not buy a second month.
      "Idempotence-Key": randomUUID(),
    },
    method: "POST",
    signal: signal ?? AbortSignal.timeout(requestTimeoutMs),
  });
  const payment = paymentSchema.parse(await response.json());
  const confirmationUrl = payment.confirmation?.confirmation_url;
  if (!response.ok || !confirmationUrl) {
    throw new Error(
      `YooKassa did not return a confirmation URL (${String(response.status)}).`
    );
  }
  return { confirmationUrl, payment };
}

/**
 * The only statement about a payment this application trusts. A webhook body
 * is attacker-controlled; this answer comes from YooKassa over an
 * authenticated request.
 */
export async function readYooKassaPayment(
  paymentId: string,
  signal?: AbortSignal
) {
  const response = await fetch(
    `${yooKassaBaseUrl}/${encodeURIComponent(paymentId)}`,
    {
      headers: { Authorization: credentials() },
      signal: signal ?? AbortSignal.timeout(requestTimeoutMs),
    }
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `YooKassa payment lookup failed (${String(response.status)}).`
    );
  }
  return paymentSchema.parse(await response.json());
}

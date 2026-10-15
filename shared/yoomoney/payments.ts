import { z } from "zod";
import { env } from "@shared/environment";
import { yoomoneyRequest } from "./api";

/**
 * A payment from the wallet's balance, in YooMoney's two calls:
 * `request-payment` checks it and names the exact sum the wallet pays
 * (`contract_amount`, with the fee), `process-payment` pays it. A
 * `request_id` is paid at most once: `process-payment` with the same one
 * again returns its outcome, which is how an `in_progress` payment or a
 * lost answer is read back. `YOOMONEY_TEST_PAYMENTS=on` makes both calls
 * YooMoney's test ones: everything is checked, nothing is charged.
 */

export const yoomoneyTestPayments = () => env.YOOMONEY_TEST_PAYMENTS === "on";

function withTestMode(body: URLSearchParams) {
  if (yoomoneyTestPayments()) {
    body.set("test_payment", "true");
    body.set("test_result", "success");
  }
  return body;
}

const requestSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  request_id: z.string().optional(),
  contract_amount: z.coerce.number().optional(),
  contract: z.string().optional(),
  money_source: z
    .object({
      wallet: z.object({ allowed: z.boolean() }).optional(),
    })
    .optional(),
});

/**
 * Checks a payment: `ready` with its `request_id` and the exact sum the
 * wallet pays, or `refused` with YooMoney's reason.
 */
export async function requestYoomoneyPayment(
  token: string,
  params: Readonly<Record<string, string>>
) {
  const parsed = requestSchema.safeParse(
    await yoomoneyRequest("/api/request-payment", {
      body: withTestMode(new URLSearchParams(params)),
      token,
    })
  );
  if (!parsed.success) return { kind: "refused" as const, error: "unknown" };
  const answer = parsed.data;
  if (
    answer.status !== "success" ||
    answer.request_id === undefined ||
    answer.contract_amount === undefined
  )
    return { kind: "refused" as const, error: answer.error ?? "unknown" };
  // The test mode's answer may say nothing of the wallet.
  if (answer.money_source?.wallet?.allowed === false && !yoomoneyTestPayments())
    return { kind: "refused" as const, error: "wallet_not_allowed" };
  return {
    kind: "ready" as const,
    requestId: answer.request_id,
    amountMinor: Math.round(answer.contract_amount * 100),
    contract: answer.contract,
  };
}

const processSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  payment_id: z.string().optional(),
  balance: z.coerce.number().optional(),
  next_retry: z.coerce.number().optional(),
});

/**
 * Pays a checked payment from the wallet's balance: `paid`, `refused`, or
 * `pending` while YooMoney still processes it (ask again after
 * `nextRetryMs` with the same `request_id`).
 */
export async function processYoomoneyPayment(token: string, requestId: string) {
  const parsed = processSchema.safeParse(
    await yoomoneyRequest("/api/process-payment", {
      body: withTestMode(
        new URLSearchParams({ request_id: requestId, money_source: "wallet" })
      ),
      token,
    })
  );
  if (!parsed.success) return { kind: "pending" as const, nextRetryMs: 5_000 };
  const answer = parsed.data;
  if (answer.status === "success")
    return {
      kind: "paid" as const,
      paymentId: answer.payment_id ?? null,
      balance: answer.balance ?? null,
    };
  if (answer.status === "in_progress")
    return {
      kind: "pending" as const,
      nextRetryMs: answer.next_retry ?? 5_000,
    };
  return { kind: "refused" as const, error: answer.error ?? answer.status };
}

/** YooMoney's refusals as the person hears them. */
const refusals = new Map(
  Object.entries({
    account_blocked:
      "ЮMoney заблокировал кошелёк: разблокировать его можно только в самом кошельке.",
    authorization_reject:
      "ЮMoney отклонил платёж: так не позволяют ограничения кошелька или получателя.",
    contract_not_found:
      "Подготовленный платёж устарел: его нужно подготовить заново.",
    ext_action_required:
      "ЮMoney просит сначала сделать что-то в самом кошельке, например пройти идентификацию.",
    illegal_param_amount: "ЮMoney не принял сумму.",
    illegal_param_amount_due: "ЮMoney не принял сумму.",
    illegal_param_to:
      "ЮMoney не принял получателя: проверь номер кошелька, телефон или почту.",
    limit_exceeded: "Превышен лимит операций кошелька.",
    not_enough_funds: "На кошельке не хватает денег.",
    payee_not_found:
      "Получатель не найден: у этого номера, телефона или почты нет кошелька ЮMoney.",
    wallet_not_allowed:
      "Этот платёж нельзя оплатить с баланса кошелька: на нём не хватает денег, или получатель не принимает оплату кошельком.",
  })
);

export function yoomoneyRefusal(error: string) {
  return refusals.get(error) ?? "ЮMoney отказал в платеже.";
}

import { z } from "zod";
import { yoomoneyHistoryPage, yoomoneyRequest } from "./api";

/**
 * A payment from the wallet's balance, in YooMoney's two calls:
 * `request-payment` checks it and names the exact sum the wallet pays
 * (`contract_amount`, with the fee), `process-payment` pays it. A
 * `request_id` is paid at most once: `process-payment` with the same one
 * again returns its outcome, which is how an `in_progress` payment or a
 * lost answer is read back. There is no test mode: YooMoney refuses the
 * `test_payment` of its old docs, and `request-payment` alone charges
 * nothing.
 */

// The wallet's linked cards: whether the person let Bro use them, and
// whether each payment needs the card's CVV. YooMoney's docs put them both
// in `money_source` and beside it.
const cardsSchema = z
  .object({
    allowed: z.boolean().optional(),
    csc_required: z.boolean().optional(),
    items: z.array(z.object({ id: z.string() })).optional(),
  })
  .optional();

const requestSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  request_id: z.string().optional(),
  contract_amount: z.coerce.number().optional(),
  contract: z.string().optional(),
  money_source: z
    .object({
      wallet: z.object({ allowed: z.boolean() }).optional(),
      cards: cardsSchema,
    })
    .optional(),
  cards: cardsSchema,
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
      body: new URLSearchParams(params),
      token,
    })
  );
  if (!parsed.success) {
    console.warn("[yoomoney] request-payment unreadable", {
      issues: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
    return { kind: "refused" as const, error: "unknown" };
  }
  const answer = parsed.data;
  // YooMoney's own words for a refusal, never the token or the payment's
  // details: what a refusal the person only hears as «отказал» was.
  const refused = (error: string) => {
    console.warn("[yoomoney] request-payment refused", {
      status: answer.status,
      error: answer.error,
      requestId: answer.request_id !== undefined,
      contractAmount: answer.contract_amount !== undefined,
      walletAllowed: answer.money_source?.wallet?.allowed,
    });
    return { kind: "refused" as const, error };
  };
  // `hold_for_pickup`: the recipient has no wallet, and the money would
  // wait for one. Bro sends money only to a wallet that exists.
  if (answer.status === "hold_for_pickup") return refused("hold_for_pickup");
  if (
    answer.status !== "success" ||
    answer.request_id === undefined ||
    answer.contract_amount === undefined
  )
    return refused(answer.error ?? "unknown");
  if (answer.money_source?.wallet?.allowed === false)
    return refused("wallet_not_allowed");
  // What paying from a linked card would take; no card's details.
  const cards = answer.money_source?.cards ?? answer.cards;
  console.info("[yoomoney] request-payment ready", {
    walletAllowed: answer.money_source?.wallet?.allowed,
    cardsAllowed: cards?.allowed,
    cscRequired: cards?.csc_required,
    cards: cards?.items?.length,
  });
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
      body: new URLSearchParams({
        request_id: requestId,
        money_source: "wallet",
      }),
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
  console.warn("[yoomoney] process-payment refused", {
    status: answer.status,
    error: answer.error,
  });
  return { kind: "refused" as const, error: answer.error ?? answer.status };
}

/**
 * A payment whose outcome was lost, in the wallet's outgoing history since
 * it was sent, page by page (at most a thousand operations). A transfer is
 * found by its label (the payment's id), paid or refused. A service has no
 * label: only a successful payment to the same entry of the catalogue for
 * the same sum counts — a refused one there may be the person's own try.
 * `absent`: the whole window was read and the payment is not in it;
 * `unread`: it was too long to read through.
 */
export async function findYoomoneyPayment(
  token: string,
  {
    amountMinor,
    label,
    patternId,
    since,
  }: {
    readonly amountMinor: number;
    readonly label?: string;
    readonly patternId?: string;
    readonly since: Date;
  }
) {
  let start: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each page starts where the last one ended.
    const { next, operations } = await yoomoneyHistoryPage(token, {
      direction: "out",
      from: since,
      label,
      records: 100,
      start,
    });
    const own = operations.filter((operation) =>
      label === undefined
        ? operation.pattern_id === patternId &&
          Math.round(operation.amount * 100) === amountMinor
        : operation.label === label
    );
    const paid = own.find((operation) => operation.status === "success");
    if (paid) return { kind: "paid" as const, operationId: paid.operation_id };
    if (label !== undefined) {
      if (own.some((operation) => operation.status === "in_progress"))
        return { kind: "pending" as const };
      if (own.some((operation) => operation.status === "refused"))
        return { kind: "refused" as const };
    }
    if (next === undefined) return { kind: "absent" as const };
    start = next;
  }
  return { kind: "unread" as const };
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
    hold_for_pickup:
      "У получателя нет кошелька ЮMoney: перевод ждал бы, пока он его заведёт. Нужен номер, телефон или почта кошелька.",
    limit_exceeded: "Превышен лимит операций кошелька.",
    not_connected:
      "Кошелёк ЮMoney не подключён или доступ к нему отозван: подключи его заново.",
    not_enough_funds: "На кошельке не хватает денег.",
    not_in_history: "ЮMoney не провёл платёж: в истории кошелька его нет.",
    payment_refused: "ЮMoney отказал в платеже.",
    payee_not_found:
      "Получатель не найден: у этого номера, телефона или почты нет кошелька ЮMoney.",
    wallet_not_allowed:
      "Этот платёж нельзя оплатить с баланса кошелька: на нём не хватает денег, или получатель не принимает оплату кошельком.",
  })
);

export function yoomoneyRefusal(error: string) {
  return refusals.get(error) ?? "ЮMoney отказал в платеже.";
}

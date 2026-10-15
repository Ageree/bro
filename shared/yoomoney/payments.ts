import { z } from "zod";
import { yoomoneyHistoryPage, yoomoneyRequest } from "./api";

/**
 * A payment from the wallet, in YooMoney's two calls: `request-payment`
 * checks it and names the exact sum (`contract_amount`, with the fee),
 * `process-payment` pays it from the balance or from a card linked to the
 * wallet. A `request_id` is paid at most once: `process-payment` with the
 * same one again returns its outcome, which is how an `in_progress`
 * payment, a card payment back from its bank or a lost answer is read
 * back. There is no test mode: YooMoney refuses the `test_payment` of its
 * old docs, and `request-payment` alone charges nothing.
 */

// The wallet's linked cards: whether the person let Bro use them, and
// whether each payment needs the card's CVV. YooMoney's docs put them both
// in `money_source` and beside it.
const cardsSchema = z
  .object({
    allowed: z.boolean().optional(),
    csc_required: z.boolean().optional(),
    items: z
      .array(z.object({ id: z.string(), pan_fragment: z.string().optional() }))
      .optional(),
  })
  .optional();

const requestSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  request_id: z.string().optional(),
  contract_amount: z.coerce.number().optional(),
  contract: z.string().optional(),
  balance: z.coerce.number().optional(),
  money_source: z
    .object({
      wallet: z.object({ allowed: z.boolean() }).optional(),
      cards: cardsSchema,
    })
    .optional(),
  cards: cardsSchema,
});

/**
 * Checks a payment: `ready` with its `request_id`, the exact sum, the
 * wallet's balance and the linked card the person let Bro pay with, or
 * `refused` with YooMoney's reason.
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
  const card = cards?.allowed === true ? cards.items?.[0] : undefined;
  const lastDigits = (card?.pan_fragment ?? "")
    .replaceAll(/\D/gu, "")
    .slice(-4);
  return {
    kind: "ready" as const,
    requestId: answer.request_id,
    amountMinor: Math.round(answer.contract_amount * 100),
    contract: answer.contract,
    balanceMinor:
      answer.balance === undefined
        ? undefined
        : Math.round(answer.balance * 100),
    card:
      card === undefined
        ? undefined
        : {
            id: card.id,
            // «••4310»: the last digits only, as the person's own app shows it.
            label: lastDigits ? `••${lastDigits}` : "привязанная",
            // Unsaid is asked: the CVV field is shown unless YooMoney says no.
            cscRequired: cards?.csc_required !== false,
          },
  };
}

const processSchema = z.object({
  status: z.string(),
  error: z.string().optional(),
  payment_id: z.string().optional(),
  balance: z.coerce.number().optional(),
  next_retry: z.coerce.number().optional(),
  // The person's browser is sent there: a bank's https page, nothing else.
  acs_uri: z.url({ protocol: /^https$/u }).optional(),
  acs_params: z.record(z.string(), z.string()).optional(),
});

/**
 * How `process-payment` is asked: from the balance; from a linked card
 * (with its CVV when YooMoney wants one, and where the bank sends the
 * person back after 3-D Secure, passed or not); or `again` — the
 * `request_id` alone, which reads a card payment back and never picks a
 * source for it.
 */
type PaymentSource =
  | { readonly kind: "wallet" }
  | { readonly kind: "again" }
  | {
      readonly kind: "card";
      readonly cardId: string;
      readonly csc: string | undefined;
      readonly returnTo: { readonly passed: string; readonly failed: string };
    };

function processBody(requestId: string, source: PaymentSource) {
  const body = new URLSearchParams({ request_id: requestId });
  if (source.kind === "wallet") body.set("money_source", "wallet");
  if (source.kind === "card") {
    body.set("money_source", source.cardId);
    if (source.csc !== undefined) body.set("csc", source.csc);
    body.set("ext_auth_success_uri", source.returnTo.passed);
    body.set("ext_auth_fail_uri", source.returnTo.failed);
  }
  return body;
}

/**
 * A read back that YooMoney answers without an outcome: `contract_not_found`
 * (the request is gone) or `illegal_params` — what the `request_id` alone
 * gets while the person's bank has not sent them back yet (15.10, a card
 * read back mid-3-D Secure). Neither says the payment was refused: the
 * wallet's history does.
 */
export const yoomoneyReadBackSilent = (error: string) =>
  error === "contract_not_found" || error === "illegal_params";

/**
 * Pays a checked payment: `paid`, `refused`, `pending` while YooMoney
 * still processes it (ask again after `nextRetryMs` with the same
 * `request_id`), or `bank` — a card payment waiting for the person on
 * their bank's 3-D Secure page, a form to POST to `acsUri`.
 */
export async function processYoomoneyPayment(
  token: string,
  requestId: string,
  source: PaymentSource
) {
  const parsed = processSchema.safeParse(
    await yoomoneyRequest("/api/process-payment", {
      body: processBody(requestId, source),
      token,
    })
  );
  if (!parsed.success) {
    console.warn("[yoomoney] process-payment unreadable", {
      source: source.kind,
      issues: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
    return { kind: "pending" as const, nextRetryMs: 5_000 };
  }
  const answer = parsed.data;
  // How each call went, without the token, the CVV or the bank's form:
  // what a card payment that never reached the person's bank did.
  console.info("[yoomoney] process-payment", {
    source: source.kind,
    status: answer.status,
    error: answer.error,
    bank:
      answer.acs_uri === undefined ? undefined : new URL(answer.acs_uri).host,
  });
  if (answer.status === "ext_auth_required") {
    return answer.acs_uri === undefined
      ? { kind: "pending" as const, nextRetryMs: 5_000 }
      : {
          kind: "bank" as const,
          acsUri: answer.acs_uri,
          acsParams: answer.acs_params ?? {},
        };
  }
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
    ext_auth_failed: "Банк не подтвердил платёж картой.",
    illegal_param_amount: "ЮMoney не принял сумму.",
    illegal_param_amount_due: "ЮMoney не принял сумму.",
    illegal_param_to:
      "ЮMoney не принял получателя: проверь номер кошелька, телефон или почту.",
    hold_for_pickup:
      "У получателя нет кошелька ЮMoney: перевод ждал бы, пока он его заведёт. Нужен номер, телефон или почта кошелька.",
    illegal_param_csc: "Банк не принял CVV карты.",
    limit_exceeded: "Превышен лимит операций кошелька.",
    money_source_not_available:
      "Этот платёж нельзя оплатить привязанной картой: ЮMoney принимает её только за услуги.",
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

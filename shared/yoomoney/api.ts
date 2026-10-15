import { z } from "zod";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * The YooMoney wallet API (yoomoney.ru/docs/wallet): the person's consent by
 * OAuth, then the balance, the history and payments under the token it
 * gives (`payments.ts`, `showcase.ts`). The token lives three years, has no
 * refresh and answers 401 once the person revokes it in the wallet's
 * settings.
 */

export const yoomoneyOrigin = "https://yoomoney.ru";

/**
 * What Bro asks for: the balance and the history, transfers to other
 * wallets (`payment-p2p`) and payments to the services of YooMoney's
 * catalogue (`payment-shop`), from the wallet's balance only. Every payment
 * still waits for the person's yes to its exact total.
 */
export const yoomoneyScope =
  "account-info operation-history payment-p2p payment-shop";

export function yoomoneyConfigured() {
  return Boolean(env.YOOMONEY_CLIENT_ID && env.YOOMONEY_CLIENT_SECRET);
}

export function yoomoneyEnabled(scope: Pick<AccessScope, "workspaceId">) {
  return (
    yoomoneyConfigured() &&
    (env.YOOMONEY_WORKSPACES?.includes("*") === true ||
      env.YOOMONEY_WORKSPACES?.includes(scope.workspaceId) === true)
  );
}

const errorMessages = {
  revoked:
    "ЮMoney больше не пускает Бро в кошелёк: доступ отозван или истёк. Подключи кошелёк заново.",
  scope: "Кошелёк подключён без права на это: отключи его и подключи заново.",
  unavailable: "ЮMoney сейчас не ответил. Попробуй позже.",
} as const;

/**
 * Why a call gave nothing: `revoked` — the token no longer opens the wallet
 * (401), so the connection is gone; `scope` — the token was granted without
 * this right (403); `unavailable` — anything else.
 */
export class YoomoneyError extends Error {
  constructor(readonly code: keyof typeof errorMessages) {
    super(errorMessages[code]);
  }
}

function credentials() {
  const clientId = env.YOOMONEY_CLIENT_ID;
  const clientSecret = env.YOOMONEY_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("Подключение ЮMoney на этом сервере не настроено.");
  return { clientId, clientSecret };
}

/**
 * The consent page. YooMoney takes it by GET as well as by the POST of its
 * docs; its Redirect URI may carry a query of the app's own (the state).
 */
export function yoomoneyAuthorizeUrl(redirectUri: string) {
  const url = new URL("/oauth/authorize", yoomoneyOrigin);
  url.searchParams.set("client_id", credentials().clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", yoomoneyScope);
  return url.toString();
}

const tokenSchema = z.object({ access_token: z.string().optional() });

/**
 * The code of the consent for a token. A wrong code, secret or Redirect URI
 * all answer 200 with an empty `access_token`, not an OAuth error.
 */
export async function exchangeYoomoneyCode(code: string, redirectUri: string) {
  const { clientId, clientSecret } = credentials();
  const answer = await yoomoneyRequest("/oauth/token", {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const token = tokenSchema.safeParse(answer).data?.access_token;
  if (!token) throw new YoomoneyError("unavailable");
  return token;
}

const amountSchema = z.coerce.number();
const accountSchema = z.object({
  account: z.string().min(1),
  balance: amountSchema,
  currency: z.string(),
  account_status: z.string(),
  balance_details: z
    .object({
      available: amountSchema.optional(),
      blocked: amountSchema.optional(),
      hold: amountSchema.optional(),
    })
    .optional(),
});

/** The wallet's number and balance (`account-info`). */
export async function readYoomoneyAccount(token: string) {
  const parsed = accountSchema.safeParse(
    await yoomoneyRequest("/api/account-info", { token })
  );
  if (!parsed.success) throw new YoomoneyError("unavailable");
  const account = parsed.data;
  return {
    account: account.account,
    balance: account.balance,
    currency: account.currency === "643" ? "RUB" : account.currency,
    status: account.account_status,
    available: account.balance_details?.available,
    blocked: account.balance_details?.blocked,
    hold: account.balance_details?.hold,
  };
}

const operationSchema = z.object({
  operation_id: z.string(),
  status: z.string(),
  datetime: z.string(),
  title: z.string().default(""),
  direction: z.enum(["in", "out"]),
  amount: amountSchema,
  type: z.string().optional(),
});
const historySchema = z.object({
  error: z.string().optional(),
  next_record: z.string().optional(),
  operations: z.array(operationSchema).default([]),
});

/**
 * The latest operations (`operation-history`), newest first: `direction`
 * narrows to incoming (`deposition`) or outgoing (`payment`), `from` to
 * those since then.
 */
export async function readYoomoneyHistory(
  token: string,
  {
    direction,
    from,
    records,
  }: {
    readonly direction?: "in" | "out";
    readonly from?: Date;
    readonly records: number;
  }
) {
  const body = new URLSearchParams({ records: String(records) });
  if (direction !== undefined)
    body.set("type", direction === "in" ? "deposition" : "payment");
  if (from !== undefined) body.set("from", from.toISOString());
  const parsed = historySchema.safeParse(
    await yoomoneyRequest("/api/operation-history", { body, token })
  );
  if (!parsed.success || parsed.data.error !== undefined)
    throw new YoomoneyError("unavailable");
  return {
    more: parsed.data.next_record !== undefined,
    operations: parsed.data.operations.map((operation) => ({
      id: operation.operation_id,
      at: operation.datetime,
      direction: operation.direction,
      amount: operation.amount,
      title: operation.title,
      status: operation.status,
    })),
  };
}

/**
 * Ends the token at YooMoney, which answers an empty 200. False when that is
 * not known: the person then revokes it in the wallet's settings.
 */
export async function revokeYoomoneyToken(token: string) {
  try {
    await yoomoneyRequest("/api/revoke", { empty: true, token });
    return true;
  } catch {
    return false;
  }
}

/**
 * A POST to the wallet API, form-encoded, under the token when one is
 * given; the answer's JSON, or null for `empty`.
 */
export async function yoomoneyRequest(
  path: string,
  {
    body,
    empty = false,
    token,
  }: {
    readonly body?: URLSearchParams;
    readonly empty?: boolean;
    readonly token?: string;
  }
) {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(new URL(path, yoomoneyOrigin), {
      method: "POST",
      headers,
      body: body ?? new URLSearchParams(),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new YoomoneyError("unavailable");
  }
  if (response.status === 401) throw new YoomoneyError("revoked");
  if (response.status === 403) throw new YoomoneyError("scope");
  if (!response.ok) throw new YoomoneyError("unavailable");
  if (empty) return null;
  try {
    const answer: unknown = await response.json();
    return answer;
  } catch {
    throw new YoomoneyError("unavailable");
  }
}

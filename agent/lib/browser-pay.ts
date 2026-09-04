/**
 * Pure helpers for paying with a vault card inside a Browser Use Cloud run via
 * `secretBindings` (API v4 `POST /runs`). The card value never reaches the
 * agent or this process's logs — the cloud server types it into the focused
 * field when the model asks for the alias by name, only while the page host
 * is one of the bound domains. Bindings die with the run.
 */
import type { PaymentPayload } from "../../convex/lib/vaultPayload.ts";

export const PAY_ALIASES = {
  number: "card_number",
  expiry: "card_expiry",
  expMonth: "card_exp_month",
  expYear: "card_exp_year",
  expYearFull: "card_exp_year_full",
  cvc: "card_cvc",
} as const;

/** Bare lowercase hostname (no scheme/port/path), or undefined if invalid. */
export function normalizePayHost(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let hostname: string;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    hostname = url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const stripped = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  if (!stripped.includes(".")) return undefined;
  if (!/^[a-z0-9.-]+$/.test(stripped)) return undefined;
  return stripped;
}

/** Normalize, drop invalid, dedupe (keep order), cap at 10 — the API max per run. */
export function normalizePayHosts(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const host = normalizePayHost(r);
    if (!host || out.includes(host)) continue;
    out.push(host);
    if (out.length >= 10) break;
  }
  return out;
}

export type SecretBinding = {
  alias: string;
  source: { type: "inline"; value: string };
  allowedDomains: string[];
};

function binding(alias: string, value: string, hosts: readonly string[]): SecretBinding {
  return {
    alias,
    source: { type: "inline", value },
    allowedDomains: [...hosts],
  };
}

/** Six secret bindings covering combined and split expiry-field forms (2- and 4-digit year). */
export function cardBindings(
  card: PaymentPayload,
  hosts: readonly string[],
): SecretBinding[] {
  if (hosts.length === 0) {
    throw new Error("cardBindings needs at least one allowed host");
  }
  const mm = String(card.expirationMonth).padStart(2, "0");
  const yy = String(card.expirationYear % 100).padStart(2, "0");
  return [
    binding(PAY_ALIASES.number, card.number, hosts),
    binding(PAY_ALIASES.expiry, `${mm}/${yy}`, hosts),
    binding(PAY_ALIASES.expMonth, mm, hosts),
    binding(PAY_ALIASES.expYear, yy, hosts),
    binding(PAY_ALIASES.expYearFull, String(card.expirationYear), hosts),
    binding(PAY_ALIASES.cvc, card.securityCode, hosts),
  ];
}

/** Russian instructions block for the cloud agent describing how to pay with bound secrets. */
export function payScaffold(opts: {
  hosts: readonly string[];
  holder: string;
  account: string;
  maxRub?: number;
}): string {
  const { hosts, holder, account, maxRub } = opts;
  const domainsLine = hosts.join(", ");
  const limitLine =
    maxRub !== undefined
      ? `Если итоговая сумма больше ${maxRub} ₽ — не плати, остановись и сообщи сумму.`
      : "";
  return [
    "Карта человека подключена секретами, и ввод делает сервер — ты значения не видишь.",
    `На форме оплаты сфокусируй поле и попроси ввести секрет по имени: \`${PAY_ALIASES.number}\` — номер карты, \`${PAY_ALIASES.expiry}\` — срок ММ/ГГ (если поля раздельные: \`${PAY_ALIASES.expMonth}\` — месяц, \`${PAY_ALIASES.expYear}\` — год двумя цифрами, \`${PAY_ALIASES.expYearFull}\` — год четырьмя), \`${PAY_ALIASES.cvc}\` — CVV.`,
    `Имя держателя карты (не секрет, можно вводить как обычный текст): ${holder}.`,
    `Карта: ${account}.`,
    `Секреты работают только на доменах ${domainsLine} и их поддоменах (www и прочие) — если страница оплаты открылась на другом домене, остановись и назови этот домен.`,
    "Никогда не читай, не переписывай и не запоминай значения этих полей.",
    "3-D Secure, код из SMS или подтверждение в приложении банка — остановись и дай live-URL.",
    limitLine,
    "После оплаты верни номер заказа, сумму и способ получения.",
  ]
    .filter(Boolean)
    .join("\n");
}

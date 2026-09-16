/**
 * Pure helpers for paying with a vault card inside a Browser Use Cloud run via
 * `secretBindings` (API v4 `POST /runs`). The card value never reaches the
 * agent or this process's logs — the cloud server types it into the focused
 * field when the model asks for the alias by name, only while the page host
 * is one of the bound domains. Bindings die with the run.
 */
import { isIP } from "node:net";
import type { LoginPayload, PaymentPayload } from "../../convex/lib/vaultPayload.ts";
import { isPrivateHost } from "./public-host.ts";

export const LOGIN_ALIASES = {
  login: "site_login",
  password: "site_password",
} as const;

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
  if (isPrivateHost(stripped) || isIP(stripped)) return undefined;
  return stripped;
}

/** Normalize, drop invalid, dedupe (keep order), cap at the API max per run. */
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

/** Browser Use API v4 cap: `allowedDomains` holds 1-10 bare hostnames. */
export const PAY_HOST_LIMIT = 10;

/**
 * Suffixes that are NOT a single owner: real multi-label public suffixes plus
 * shared-hosting domains where every customer is a separate subdomain. A host
 * under one of these must never be widened to it — `shop.myshopify.com` stays
 * itself, it never becomes `myshopify.com`.
 */
const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "com.ru", "net.ru", "org.ru", "pp.ru", "msk.ru", "spb.ru",
  "com.ua", "com.by", "com.kz", "org.kz", "com.ge", "com.am",
  "co.uk", "org.uk", "ac.uk", "co.jp", "com.tr", "com.cn", "com.br",
  "com.au", "co.il", "co.in",
  "amazonaws.com", "cloudfront.net", "herokuapp.com", "vercel.app",
  "netlify.app", "github.io", "web.app", "firebaseapp.com",
  "azurewebsites.net", "pages.dev", "workers.dev", "r2.dev",
  "myshopify.com", "shopify.com", "tilda.ws", "wixsite.com",
  "ngrok.io", "ngrok-free.app", "onrender.com", "fly.dev", "glitch.me",
]);

/**
 * Registrable domain (eTLD+1) of a host, or undefined if the host is unusable.
 * `taxi.yandex.ru` → `yandex.ru`, and because a bound host covers its
 * subdomains, that one entry also covers `pay.`/`trust.`/`passport.yandex.ru`
 * — the sibling hosts a Yandex card form actually lives on.
 */
export function registrableDomain(host: string): string | undefined {
  const norm = normalizePayHost(host);
  if (!norm) return undefined;
  const labels = norm.split(".");
  if (labels.length <= 2) return norm;
  const two = labels.slice(-2).join(".");
  const base = PUBLIC_SUFFIXES.has(two) ? labels.slice(-3).join(".") : two;
  return normalizePayHost(base);
}

/**
 * Sibling hosts a site's card form lives on that its own registrable domain
 * does NOT already cover — cross-TLD or a different company entirely. Small
 * and curated on purpose: the registrable domain above and the processor list
 * below are the general mechanism, this table is only for what they miss.
 */
const SITE_PAYMENT_HOSTS: ReadonlyMap<string, readonly string[]> = new Map([
  ["yandex.com", ["yandex.ru", "yoomoney.ru"]],
  ["ya.ru", ["yandex.ru", "yoomoney.ru"]],
  ["yandex.ru", ["yoomoney.ru"]],
  ["wildberries.ru", ["wb.ru"]],
  ["wb.ru", ["wildberries.ru"]],
]);

/**
 * Russian card-acceptance forms (and the acquiring hosts that render them)
 * that any merchant may hand the checkout over to. Bank hosts are named by
 * their acquiring subdomain, never the bare bank domain — a card must never be
 * typeable on an online-banking login page.
 */
const PROCESSOR_HOSTS: readonly string[] = [
  "yookassa.ru",
  "yoomoney.ru",
  "cloudpayments.ru",
  "securepay.tinkoff.ru",
  "securepayments.sberbank.ru",
  "pay.alfabank.ru",
];

/** A bound host covers its own subdomains, so `yandex.ru` makes `pay.yandex.ru` redundant. */
function covers(parent: string, child: string): boolean {
  return parent === child || child.endsWith(`.${parent}`);
}

function expand(
  raw: readonly string[],
  opts: { processors: boolean; siteExtras: boolean },
): string[] {
  const base = normalizePayHosts(raw);
  if (base.length === 0) return [];
  // Interleaved host/root pairs first, so a caller that fills all 10 slots
  // with merchant hosts still gets roots in — truncation drops the lowest
  // priority tail, never the widening that makes the card typeable at all.
  const candidates: string[] = [];
  const roots: string[] = [];
  for (const host of base) {
    candidates.push(host);
    const root = registrableDomain(host);
    if (root) {
      roots.push(root);
      candidates.push(root);
    }
  }
  if (opts.siteExtras) {
    for (const root of roots) {
      for (const extra of SITE_PAYMENT_HOSTS.get(root) ?? []) candidates.push(extra);
    }
  }
  if (opts.processors) candidates.push(...PROCESSOR_HOSTS);

  const kept: string[] = [];
  for (const candidate of candidates) {
    const host = normalizePayHost(candidate);
    if (!host) continue;
    if (kept.some((k) => covers(k, host))) continue;
    kept.push(host);
    if (kept.length >= PAY_HOST_LIMIT) break;
  }
  // A narrower host added before its own parent is now redundant — drop it so
  // the cap is spent on domains that actually widen the binding.
  return kept.filter((h) => !kept.some((o) => o !== h && covers(o, h)));
}

/**
 * Domains to bind the vault CARD to. The merchant hosts, their registrable
 * domains (a payment form on a sibling host — pay./trust./passport.yandex.ru —
 * is the usual reason a card never gets typed), curated cross-TLD siblings,
 * then the common Russian processors, capped at the API's 10.
 */
export function expandPayHosts(raw: readonly string[]): string[] {
  return expand(raw, { processors: true, siteExtras: true });
}

/**
 * Domains to bind a vault LOGIN to: the site's own hosts plus their
 * registrable domain (Yandex logins happen on passport.yandex.ru, not on
 * taxi.yandex.ru). Never a payment processor — a password has no business
 * being typeable on one.
 */
export function expandLoginHosts(raw: readonly string[]): string[] {
  return expand(raw, { processors: false, siteExtras: false });
}

/** «привяжи карту» / «добавь способ оплаты» / "add a card" — moved next to
 *  `taskLooksLikeBuy` in convex/lib/purchasePolicy.ts so the Convex
 *  follow-through applies the same "a saved card is not a purchase" rule. */
export { isAttachCardErrand } from "../../convex/lib/purchasePolicy.ts";


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

/** Login + password bindings. The model only sees the alias names. */
export function loginBindings(
  payload: LoginPayload,
  hosts: readonly string[],
): SecretBinding[] {
  if (hosts.length === 0) {
    throw new Error("loginBindings needs at least one allowed host");
  }
  if (payload.authentication.type !== "password") {
    throw new Error("loginBindings needs a password login");
  }
  return [
    binding(LOGIN_ALIASES.login, payload.identifier.value, hosts),
    binding(LOGIN_ALIASES.password, payload.authentication.password, hosts),
  ];
}

/** Cloud-agent instructions when a vault password is bound to the run. */
export function loginScaffold(): string {
  return [
    `Логин и пароль подключены секретами: сфокусируй поле и попроси секрет по имени — \`${LOGIN_ALIASES.login}\` (логин, почта или телефон), \`${LOGIN_ALIASES.password}\` (пароль), потом нажми «Войти». Значения вводит сервер, ты их не видишь.`,
    "Просит код из SMS — закончи с НУЖНО: sms_code, код на почту — НУЖНО: email_code.",
  ].join("\n");
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

/**
 * Russian instructions block for the cloud agent describing how to pay — or,
 * with `attachCard`, how to save the card without buying anything.
 */
export function payScaffold(opts: {
  hosts: readonly string[];
  holder: string;
  account: string;
  maxRub?: number;
  /** «привяжи карту»: save the card as a payment method, place no order. */
  attachCard?: boolean;
}): string {
  const { hosts, holder, account, maxRub, attachCard } = opts;
  return [
    attachCard
      ? "Цель — привязать карту, а не купить: открой «Способы оплаты» (профиль, настройки или корзина) и нажми «Добавить карту»."
      : "",
    `Карта ${account} подключена секретами: сфокусируй поле и попроси секрет по имени — \`${PAY_ALIASES.number}\`, \`${PAY_ALIASES.expiry}\` (срок ММ/ГГ; раздельные поля: \`${PAY_ALIASES.expMonth}\` месяц, \`${PAY_ALIASES.expYear}\` год двумя цифрами, \`${PAY_ALIASES.expYearFull}\` четырьмя), \`${PAY_ALIASES.cvc}\` CVV. Вводит сервер, ты значений не видишь.`,
    "Форма карты обычно в iframe на соседнем домене — кликай прямо в поле внутри рамки и проси секрет там же, это работает.",
    `Держатель ${holder} — не секрет, печатай его текстом.`,
    `Секреты работают только на ${hosts.join(", ")} и их поддоменах. Поле карты на другом домене — закончи, назови его, НУЖНО: payment.`,
    "3-D Secure — НУЖНО: 3ds. Код из SMS — НУЖНО: sms_code. Подтверждение в приложении банка — НУЖНО: push.",
    maxRub !== undefined ? `Сумма выше ${maxRub} ₽ — не плати, закончи и назови её.` : "",
    attachCard
      ? "Банк может списать и вернуть около 1 ₽ — это нормально, не повод останавливаться. Готово, когда карта видна в списке способов оплаты: так и напиши в СДЕЛАНО, заказ не оформляй."
      : "После оплаты убедись, что на экране есть номер заказа, и верни его и сумму.",
  ]
    .filter(Boolean)
    .join("\n");
}

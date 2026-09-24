import { isIP } from "node:net";
import { isPublicSuffix } from "@shared/browser/public-suffixes";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  parseLoginVaultPayload,
  parsePaymentCardSecret,
} from "@shared/vault/schema";
import { readVaultItems, readVaultSecret } from "@db/services/vault";
import type { BrowserUseSecretBinding } from "./client";

/** Browser Use caps `allowedDomains` at ten bare hostnames per binding. */
const allowedDomainLimit = 10;

/**
 * Card-acceptance forms a Russian merchant may hand its checkout over to.
 * Banks are named by their acquiring subdomain, never the bare bank domain: a
 * card must never be typeable on an online-banking login page.
 */
const paymentProcessorHosts = [
  "yookassa.ru",
  "yoomoney.ru",
  "cloudpayments.ru",
  "securepay.tinkoff.ru",
  "securepayments.sberbank.ru",
  "pay.alfabank.ru",
];

const browserSecretAliases = {
  cardCvc: "card_cvc",
  cardExpiry: "card_expiry",
  cardHolder: "card_holder",
  cardNumber: "card_number",
  loginPassword: "login_password",
  loginUsername: "login_username",
} as const;

export interface BrowserVaultEntry {
  readonly account: string;
  readonly id: string;
  readonly kind: string;
}

/** Bare lowercase hostname, or undefined when the input cannot host a secret. */
function secretHost(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = URL.parse(
    trimmed.includes("://") ? trimmed : `https://${trimmed}`
  );
  if (!parsed) return undefined;
  const hostname = parsed.hostname.toLowerCase();
  const stripped = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  if (!stripped.includes(".")) return undefined;
  if (!/^[a-z0-9.-]+$/u.test(stripped)) return undefined;
  if (isIP(stripped) !== 0) return undefined;
  return stripped;
}

/**
 * Registrable domain of a host. A bound host covers its subdomains, so
 * `taxi.yandex.ru` widening to `yandex.ru` is what makes a login typeable on
 * `passport.yandex.ru`, where the form actually lives.
 */
export function registrableDomain(host: string) {
  const normalized = secretHost(host);
  if (!normalized) return undefined;
  const labels = normalized.split(".");
  if (labels.length <= 2) return normalized;
  const lastTwo = labels.slice(-2).join(".");
  return isPublicSuffix(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

function withoutRedundantHosts(candidates: readonly string[]) {
  const kept: string[] = [];
  for (const candidate of candidates) {
    const host = secretHost(candidate);
    if (!host) continue;
    if (kept.some((other) => host === other || host.endsWith(`.${other}`))) {
      continue;
    }
    kept.push(host);
    if (kept.length >= allowedDomainLimit) break;
  }
  return kept;
}

/**
 * The hosts a stored login may be typed on: the errand's site widened to its
 * registrable domain, plus the host the login was actually saved for when that
 * one is not already covered — a password saved for a sign-in host has to be
 * typeable there.
 */
export function loginAllowedDomains(site: string, loginOrigin?: string) {
  const host = secretHost(site);
  if (!host) return [];
  const stored = loginOrigin ? secretHost(loginOrigin) : undefined;
  return withoutRedundantHosts([
    registrableDomain(host) ?? host,
    host,
    ...(stored ? [stored] : []),
  ]);
}

export function paymentAllowedDomains(site: string) {
  const host = secretHost(site);
  if (!host) return [];
  return withoutRedundantHosts([
    registrableDomain(host) ?? host,
    host,
    ...paymentProcessorHosts,
  ]);
}

/**
 * The vault items a run may use: the login stored for exactly this site, and
 * the payment card only when the user approved paying on this errand.
 *
 * A login is matched on the origin recorded with it, never on the errand text,
 * so a password can only ever be bound to the site it was saved for. Vault
 * account hints are prefixed with the saved origin's hostname, which keeps the
 * match to a list read instead of decrypting every stored login.
 *
 * The exact host wins. Failing that, a login saved anywhere under the same
 * registrable domain serves the errand — the account behind `taxi.yandex.ru`
 * is the one saved for `yandex.ru` or `passport.yandex.ru` — and nothing is
 * ever matched across two registrable domains.
 */
export function selectBrowserVaultItems(
  entries: readonly BrowserVaultEntry[],
  options: { readonly allowPayment: boolean; readonly site: string | undefined }
) {
  const host = options.site ? secretHost(options.site) : undefined;
  const domain = host ? registrableDomain(host) : undefined;
  const logins = entries.filter((entry) => entry.kind === "login");
  const login = host
    ? (logins.find((entry) => storedLoginHost(entry) === host) ??
      logins.find((entry) => {
        const stored = storedLoginHost(entry);
        return (
          stored !== undefined &&
          domain !== undefined &&
          registrableDomain(stored) === domain
        );
      }))
    : undefined;
  const payment =
    options.allowPayment && host
      ? entries.find((entry) => entry.kind === "payment")
      : undefined;
  return { loginId: login?.id, paymentId: payment?.id };
}

/** The hostname a login's account hint was prefixed with when it was saved. */
function storedLoginHost(entry: BrowserVaultEntry) {
  const [stored] = entry.account.split(" · ");
  return stored ? secretHost(stored) : undefined;
}

function binding(
  alias: string,
  value: string,
  allowedDomains: readonly string[]
) {
  return {
    allowedDomains: [...allowedDomains],
    alias,
    source: { type: "inline", value },
  } satisfies BrowserUseSecretBinding;
}

/**
 * Turn the selected vault secrets into Browser Use `secretBindings`. The
 * returned `aliases` are the only part of this that may be shown to a model:
 * the values live in `bindings` and go straight into the run request body.
 */
export function browserSecretBindings(options: {
  readonly card: string | undefined;
  readonly login: string | undefined;
  readonly site: string;
}) {
  const bindings: BrowserUseSecretBinding[] = [];
  if (options.login) {
    const payload = parseLoginVaultPayload(options.login);
    const domains = loginAllowedDomains(
      options.site,
      payload && "origin" in payload ? payload.origin : undefined
    );
    if (payload && domains.length > 0) {
      bindings.push(
        binding(
          browserSecretAliases.loginUsername,
          payload.identifier.value,
          domains
        )
      );
      if (payload.authentication.type === "password") {
        bindings.push(
          binding(
            browserSecretAliases.loginPassword,
            payload.authentication.password,
            domains
          )
        );
      }
    }
  }
  if (options.card) {
    const card = parsePaymentCardSecret(options.card);
    const domains = paymentAllowedDomains(options.site);
    if (domains.length > 0) {
      const month = String(card.expirationMonth).padStart(2, "0");
      const year = String(card.expirationYear % 100).padStart(2, "0");
      bindings.push(
        binding(browserSecretAliases.cardNumber, card.number, domains),
        binding(browserSecretAliases.cardExpiry, `${month}/${year}`, domains),
        binding(browserSecretAliases.cardCvc, card.securityCode, domains),
        binding(browserSecretAliases.cardHolder, card.cardholderName, domains)
      );
    }
  }
  return {
    aliases: bindings.map((item) => item.alias),
    bindings,
  };
}

/** Read the selected vault secrets and bind them, all server-side. */
export async function resolveBrowserSecretBindings(
  scope: AccessScope,
  options: { readonly allowPayment: boolean; readonly site: string | undefined }
) {
  if (!options.site) return { aliases: [], bindings: [] };
  const selected = selectBrowserVaultItems(
    await readVaultItems(scope),
    options
  );
  const [login, card] = await Promise.all([
    selected.loginId ? readVaultSecret(scope, selected.loginId) : undefined,
    selected.paymentId ? readVaultSecret(scope, selected.paymentId) : undefined,
  ]);
  return browserSecretBindings({ card, login, site: options.site });
}

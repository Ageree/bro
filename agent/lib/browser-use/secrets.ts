import { isIP } from "node:net";
import { isPublicSuffix } from "@shared/browser/public-suffixes";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  parseLoginVaultPayload,
  parsePaymentCardSecret,
} from "@shared/vault/schema";
import { readVaultItems, readVaultSecret } from "@db/services/vault";
import { readOwnPhone } from "./facts";
import type { BrowserUseSecretBinding } from "./client";
import {
  gosuslugiDomain,
  isGosuslugi,
  signsInWithGosuslugi,
} from "./public-services";

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

export const browserSecretAliases = {
  cardCvc: "card_cvc",
  cardExpiry: "card_expiry",
  cardHolder: "card_holder",
  cardNumber: "card_number",
  gosuslugiPassword: "gosuslugi_password",
  gosuslugiUsername: "gosuslugi_username",
  loginPassword: "login_password",
  loginPhoneDigits: "login_phone_digits",
  loginUsername: "login_username",
  signinPhone: "signin_phone",
  signinPhoneDigits: "signin_phone_digits",
} as const;

/**
 * A phone as people write it — «+7 (916) 123–45–67», «8 916 123 45 67
 * (моб.)» — as its digits alone, with a plus only when one comes before
 * them. Undefined when there are no digits at all.
 */
function compactPhone(phone: string) {
  const digits = phone.replaceAll(/\D/gu, "");
  if (digits === "") return undefined;
  return /^\D*\+/u.test(phone) ? `+${digits}` : digits;
}

/**
 * A Russian phone number as the 10 digits after +7 — what a field that
 * already shows «+7» or a mask «+7 (___) ___-__-__» takes: Ozon rejected a
 * saved «+7…» login typed into such a field as a malformed phone (RU 25.09,
 * d04). Undefined for any other number.
 */
export function nationalPhoneDigits(phone: string) {
  const compact = compactPhone(phone) ?? "";
  // +7, or 7 or 8 without a plus, then ten digits of a Russian area or mobile
  // code — never +84, +852 or any other country's number.
  const match = /^(?:\+7|7|8)([3489]\d{9})$/u.exec(compact);
  return match?.[1];
}

/**
 * The sentence, word for word, that tells a run to sign in with the
 * person's phone. It is also how a queued start, a background retry and a
 * follow-up know the errand's start bound the phone: the bare alias can turn
 * up in errand text a model wrote, this sentence only where the tool put it.
 */
export const phoneSignInSentence = `If the site asks you to sign in and offers to sign in by phone number with a code sent by SMS or a push, sign in to the person's own account there with their phone: focus the phone field and ask for the secret ${browserSecretAliases.signinPhone}.`;

/**
 * The same phone login as its 10 digits, under an alias of its own, for a
 * field that already shows the country code: the run never sees the value,
 * so it cannot drop the +7 itself.
 *
 * Never for Госуслуги: ESIA has one field for a phone, an email or a СНИЛС
 * and wants the whole number. With the digits bound, the run typed them
 * there and ESIA answered «Заполните поле» (RU 25.09, d06), where the same
 * login alone had reached the SMS step that morning.
 */
function phoneDigitsBinding(
  alias: string,
  identifier: { readonly type: string; readonly value: string },
  domains: readonly string[]
) {
  if (identifier.type !== "phone" || domains.some(isGosuslugi)) return [];
  const digits = nationalPhoneDigits(identifier.value);
  return digits === undefined ? [] : [binding(alias, digits, domains)];
}

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
 * Where the person's phone may be typed to sign in: the errand's site and
 * every host of its registrable domain — Yandex signs people in on
 * passport.yandex.ru for an errand on market.yandex.ru — and nowhere else.
 * Nothing for a host whose registrable domain is a public suffix.
 */
export function phoneSignInDomains(site: string) {
  const host = secretHost(site);
  const domain = host === undefined ? undefined : registrableDomain(host);
  if (domain === undefined || isPublicSuffix(domain)) return [];
  return [domain];
}

/**
 * The person's own phone, bound as a secret for signing in on the errand's
 * site where no login is saved for it: the run types it by alias and never
 * sees it, and Browser Use types it only on that site's registrable domain,
 * whatever a page or a redirect asks. A Russian number goes as +7 and its
 * ten digits too, for a field that already shows «+7».
 */
function phoneSignInBindings(phone: string, site: string) {
  const domains = phoneSignInDomains(site);
  const compact = compactPhone(phone);
  if (domains.length === 0 || compact === undefined) return [];
  const digits = nationalPhoneDigits(compact);
  return [
    // The number alone: a note written next to it in the profile is never
    // typed into a site.
    binding(
      browserSecretAliases.signinPhone,
      digits === undefined ? compact : `+7${digits}`,
      domains
    ),
    ...(digits === undefined
      ? []
      : [binding(browserSecretAliases.signinPhoneDigits, digits, domains)]),
  ];
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
 *
 * The one crossing is Госуслуги: a public-service site that signs people in
 * through it (`signsInWithGosuslugi`) also gets the Госуслуги login, bound
 * under aliases of its own and typeable on gosuslugi.ru alone, where the
 * ESIA sign-in page is — never on the errand's site itself.
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
  const gosuslugi =
    host !== undefined && signsInWithGosuslugi(host) && !isGosuslugi(host)
      ? logins.find((entry) => {
          const stored = storedLoginHost(entry);
          return stored !== undefined && isGosuslugi(stored);
        })
      : undefined;
  const payment =
    options.allowPayment && host
      ? entries.find((entry) => entry.kind === "payment")
      : undefined;
  return {
    gosuslugiLoginId: gosuslugi?.id,
    loginId: login?.id,
    paymentId: payment?.id,
  };
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
  readonly gosuslugiLogin?: string | undefined;
  readonly login: string | undefined;
  /** The person's own phone, for a site no saved login signs in to. */
  readonly signInPhone?: string | undefined;
  readonly site: string;
}) {
  const bindings: BrowserUseSecretBinding[] = [];
  if (options.gosuslugiLogin) {
    const payload = parseLoginVaultPayload(options.gosuslugiLogin);
    if (payload) {
      bindings.push(
        binding(
          browserSecretAliases.gosuslugiUsername,
          payload.identifier.value,
          [gosuslugiDomain]
        )
      );
      if (payload.authentication.type === "password") {
        bindings.push(
          binding(
            browserSecretAliases.gosuslugiPassword,
            payload.authentication.password,
            [gosuslugiDomain]
          )
        );
      }
    }
  }
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
        ),
        ...phoneDigitsBinding(
          browserSecretAliases.loginPhoneDigits,
          payload.identifier,
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
  const signedIn = bindings.some(
    (item) =>
      item.alias === browserSecretAliases.loginUsername ||
      item.alias === browserSecretAliases.gosuslugiUsername
  );
  if (options.signInPhone !== undefined && !signedIn) {
    bindings.push(...phoneSignInBindings(options.signInPhone, options.site));
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

/**
 * Read the selected vault secrets and bind them, all server-side.
 * `phoneSignIn`: the errand may sign in on its site with the person's own
 * phone when no login is saved for it — an errand the person started.
 */
export async function resolveBrowserSecretBindings(
  scope: AccessScope,
  options: {
    readonly allowPayment: boolean;
    readonly phoneSignIn?: boolean;
    readonly site: string | undefined;
  }
) {
  if (!options.site) return { aliases: [], bindings: [] };
  const selected = selectBrowserVaultItems(
    await readVaultItems(scope),
    options
  );
  const [login, gosuslugiLogin, card, signInPhone] = await Promise.all([
    selected.loginId ? readVaultSecret(scope, selected.loginId) : undefined,
    selected.gosuslugiLoginId
      ? readVaultSecret(scope, selected.gosuslugiLoginId)
      : undefined,
    selected.paymentId ? readVaultSecret(scope, selected.paymentId) : undefined,
    options.phoneSignIn === true ? readOwnPhone(scope) : undefined,
  ]);
  return browserSecretBindings({
    card,
    gosuslugiLogin,
    login,
    signInPhone,
    site: options.site,
  });
}

/**
 * Whether a composed run was told to sign in with the person's phone, which
 * only an errand whose start bound it carries on: a queued start, a
 * background retry and a follow-up bind the phone again only then.
 */
export function signsInByPhone(task: string) {
  return task.includes(phoneSignInSentence);
}

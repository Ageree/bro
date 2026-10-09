import {
  isGosuslugi,
  signsInWithGosuslugi,
} from "@agent/lib/browser-use/public-services";
import { registrableDomain } from "@agent/lib/browser-use/secrets";
import { isPublicSuffix } from "@shared/browser/public-suffixes";

/**
 * The pages a sign-in may pass through besides the site itself: where
 * «Войти через…» sends the person, by exact host. Not whole domains: the
 * browser's profile may be signed in to the provider (a previous sign-in),
 * and a viewer on `vk.com` or `yandex.ru` would reach messages and mail.
 * The viewer's page may be on these and on the site's own domain, and
 * nowhere else (`browser-vm/worker/worker.py`, `HandoffGuard`).
 */
export const signInProviderHosts = [
  "account.mail.ru",
  "id.sber.ru",
  "id.vk.com",
  "login.vk.com",
  "oauth.mail.ru",
  "oauth.vk.com",
  "oauth.yandex.ru",
  "passport.yandex.ru",
] as const;

/**
 * Sites whose sign-in lives on another domain of their own, so the fence
 * lets the person follow it: Wildberries signs in on wb.ru (WB ID).
 */
const ownSignInDomains = new Map<string, readonly string[]>([
  ["wildberries.ru", ["wb.ru"]],
]);

/** What the person's words pointed at, as the fence and the viewer know it. */
export type HandoffSite =
  | {
      readonly allowedDomains: readonly string[];
      readonly domain: string;
      readonly kind: "ok";
      /** The page the viewer opens: the site's address without query or fragment. */
      readonly url: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: "gosuslugi" | "invalid";
    };

/**
 * A site as the person named it (`ozon.ru`, `www.avito.ru/profile`,
 * `https://id.vk.com`) to the page a sign-in opens and the domains it may
 * stay on. Not an address of a shared suffix, a bare IP, a login in the
 * address, or a port: only a site by name. Госуслуги and the sites that
 * sign in through it are refused: they ask for a code on every new device,
 * so a kept sign-in would not help.
 */
export function handoffSite(raw: string): HandoffSite {
  const text = raw.trim();
  const url = URL.parse(
    /^[a-z][a-z\d+.-]*:\/\//iu.test(text) ? text : `https://${text}`
  );
  if (
    !url ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443" && url.port !== "80")
  ) {
    return { kind: "refused", reason: "invalid" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (isGosuslugi(host) || signsInWithGosuslugi(host)) {
    return { kind: "refused", reason: "gosuslugi" };
  }
  const domain = registrableDomain(host);
  if (
    domain === undefined ||
    !domain.includes(".") ||
    isPublicSuffix(domain) ||
    /^[\d.]+$/u.test(host) ||
    host.includes(":") ||
    !/^[a-z\d.-]+$/u.test(host)
  ) {
    return { kind: "refused", reason: "invalid" };
  }
  return {
    allowedDomains: [
      ...new Set([domain, ...(ownSignInDomains.get(domain) ?? [])]),
    ],
    domain,
    kind: "ok",
    url: `https://${host}${url.pathname === "" ? "/" : url.pathname}`,
  };
}

/**
 * Whether the person's own words name the site: its domain, or the whole
 * address of a link they sent. The model may not bring a site from a page or
 * a search — a sign-in link is a link to a form that takes a password.
 */
export function namedInWords(domain: string, said: readonly string[]) {
  const pattern = new RegExp(
    `(?:^|[^a-z\\d-])(?:[a-z\\d-]+\\.)*${domain.replaceAll(".", "\\.")}(?![a-z\\d-]|\\.[a-z\\d])`,
    "iu"
  );
  return said.some((words) => pattern.test(words));
}

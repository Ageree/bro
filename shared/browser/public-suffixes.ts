/**
 * Suffixes that are not a single owner: real multi-label public suffixes plus
 * shared-hosting domains where every customer is its own subdomain. A host
 * under one of these is never widened to it, and nothing the person allows —
 * a saved login, a spend limit, a standing permission — is granted to the
 * suffix itself: «tilda.ws» would be every Tilda site at once.
 */
const publicSuffixes = new Set([
  "amazonaws.com",
  "co.il",
  "co.in",
  "co.jp",
  "co.uk",
  "com.au",
  "com.br",
  "com.by",
  "com.cn",
  "com.ge",
  "com.kz",
  "com.ru",
  "com.tr",
  "com.ua",
  "github.io",
  "gov.ru",
  "msk.ru",
  "myshopify.com",
  "net.ru",
  "org.kz",
  "org.ru",
  "org.uk",
  "pages.dev",
  "pp.ru",
  "shopify.com",
  "spb.ru",
  "tilda.ws",
  "vercel.app",
  "wixsite.com",
]);

/** Whether a bare lower-case host is one of the shared suffixes itself. */
export function isPublicSuffix(host: string) {
  return publicSuffixes.has(host);
}

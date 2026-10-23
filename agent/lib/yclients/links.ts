import { downloadWithin } from "@agent/lib/inbound-media/download";
import { isBlockedHost } from "@agent/lib/outbound-media/attachments";
import { fetchPublic } from "@agent/lib/sandbox/public-fetch";
import { decodePage } from "@agent/lib/web-page/decode";

/** A salon's home page with its booking button fits; a bigger one is not read. */
const maximumPageBytes = 2 * 1024 * 1024;

/** A page names this many booking links at most worth asking YClients about. */
const maximumLinks = 5;

const browserUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * A YClients booking link names its booking form in the subdomain
 * (`n102887.yclients.com`, `w123.yclients.ru`, `b383401.yclients.com`), its
 * company in the path (`/company/1164989/…`), or both; the company is what
 * the booking calls take, and a form names one through `bookform/{id}`.
 */
const formHost = /^(?:[bnw])(?<form>\d{1,9})\.yclients\.(?:com|ru)$/u;
const companyPath = /\/company\/(?<company>\d{1,9})(?:[/?#]|$)/u;

/** What one YClients link names: its company, its form, or both. */
function linkIds(url: URL) {
  const host = url.hostname.toLowerCase();
  if (
    host !== "yclients.com" &&
    host !== "yclients.ru" &&
    !host.endsWith(".yclients.com") &&
    !host.endsWith(".yclients.ru")
  ) {
    return undefined;
  }
  const company = companyPath.exec(url.pathname)?.groups?.company;
  const form = formHost.exec(host)?.groups?.form;
  if (company === undefined && form === undefined) return undefined;
  return {
    company: company === undefined ? undefined : Number(company),
    form: form === undefined ? undefined : Number(form),
  };
}

/**
 * The YClients booking links in a page's HTML, found by `indexOf`: a regular
 * expression over a stranger's 2 MB could stall the process (`htmlTags` in
 * `agent/lib/subscriptions/price.ts`), so only a short window around each
 * «yclients.» is matched.
 */
export function bookingLinksIn(html: string) {
  const lower = html.toLowerCase();
  const found = new Map<string, NonNullable<ReturnType<typeof linkIds>>>();
  for (
    let at = lower.indexOf("yclients.");
    at !== -1 && found.size < maximumLinks;
    at = lower.indexOf("yclients.", at + 1)
  ) {
    const window = lower.slice(Math.max(0, at - 24), at + 200);
    const start = window.search(/(?:https?:)?\/\/[a-z0-9.-]*yclients\./u);
    const hostStart =
      start === -1 ? window.search(/[bnw]\d{1,9}\.yclients\./u) : start;
    if (hostStart === -1) continue;
    const raw = window.slice(hostStart).split(/["'\s<>\\]/u)[0] ?? "";
    const url = URL.parse(
      raw.startsWith("//")
        ? `https:${raw}`
        : raw.startsWith("http")
          ? raw
          : `https://${raw}`
    );
    const ids = url === null ? undefined : linkIds(url);
    if (ids !== undefined)
      found.set(`${String(ids.company)}:${String(ids.form)}`, ids);
  }
  return [...found.values()];
}

/**
 * The YClients booking links a link leads to: the link itself when it is
 * one, else the ones on the page it opens (a salon's site, its «Записаться»
 * page). The page is read with one plain HTTPS request to public addresses
 * only, every redirect checked; nothing about it is logged.
 */
export async function bookingLinksOf(link: URL) {
  const own = linkIds(link);
  if (own !== undefined) return { kind: "found" as const, links: [own] };
  const download = await downloadWithin(link, maximumPageBytes, {
    allowUrl: (next) => !isBlockedHost(next.hostname),
    fetch: fetchPublic,
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
      "user-agent": browserUserAgent,
    },
  });
  if (download.kind !== "bytes") return { kind: "unreachable" as const };
  const links = bookingLinksIn(decodePage(download.bytes, download.mediaType));
  return { kind: "found" as const, links };
}

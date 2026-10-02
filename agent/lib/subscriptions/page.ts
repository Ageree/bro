import { downloadWithin } from "@agent/lib/inbound-media/download";
import { isBlockedHost } from "@agent/lib/outbound-media/attachments";
import { fetchPublic } from "@agent/lib/sandbox/public-fetch";
import { botCheckWording } from "@agent/lib/web-page/challenge";
import { decodePage } from "@agent/lib/web-page/decode";
import { type PriceRead, type PriceReading, readPrice } from "./price";

/** A product page with its JSON-LD fits; a bigger answer is not a product. */
const maximumPageBytes = 2 * 1024 * 1024;

/**
 * Shops answer a plain bot's user agent with a stub; a browser's is what
 * their own markup for search engines is served to.
 */
const browserUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * What a check read: the price, why the page has none (`PriceRead`), or why
 * no page was read — it did not open (`unreachable`, with the download's
 * own fixed reason), or a bot check or a refusal stood in its place
 * (`blocked`).
 */
export type PageRead =
  | Exclude<PriceRead, PriceReading>
  | (PriceReading & { readonly landedOn: string })
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

/** Query parameters that only track where a visitor came from. */
const trackingParameter =
  /^(?:utm_\w+|gclid|yclid|fbclid|_openstat|from|ref|referrer|srsltid|clid)$/iu;

/**
 * The page a link names: host without `www.`, path without the trailing
 * slash, and the query without tracking parameters, in a fixed order.
 * «?id=1» and «?id=2» are two products; «?utm_source=…» is the same one.
 */
export function pageKey(url: URL) {
  const query = [...url.searchParams]
    .filter(([name]) => !trackingParameter.test(name))
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.hostname.replace(/^www\./u, "")}${path}${query ? `?${query}` : ""}`;
}

const blockingStatuses = new Set(["http 401", "http 403", "http 429"]);

/**
 * Reads the price on a public product page with one plain HTTPS request:
 * every hop goes only to an address checked public (`fetchPublic`), each
 * redirect is checked before it is followed, and the body stops at 2 MB.
 * Nothing about the page is logged.
 */
export async function readPricePage(url: URL): Promise<PageRead> {
  let landedOn = url;
  const download = await downloadWithin(url, maximumPageBytes, {
    allowUrl: (next) => !isBlockedHost(next.hostname),
    // Each hop passes here, so the last one is the page that answered.
    fetch: async (hop, init) => {
      landedOn = hop;
      return fetchPublic(hop, init);
    },
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
      "user-agent": browserUserAgent,
    },
  });
  if (download.kind === "oversize") {
    return { kind: "unreachable", reason: "oversize" };
  }
  if (download.kind === "failed") {
    return blockingStatuses.has(download.reason)
      ? { kind: "blocked", reason: download.reason }
      : { kind: "unreachable", reason: download.reason };
  }
  const html = decodePage(download.bytes, download.mediaType);
  const reading = readPrice(html);
  if (reading.kind === "price") {
    return { ...reading, landedOn: pageKey(landedOn) };
  }
  if (reading.kind !== "no-price") return reading;
  const title = /<title[^>]*>([^<]{0,300})/iu.exec(html)?.[1] ?? "";
  return botCheckWording.test(title)
    ? { kind: "blocked", reason: "bot-check" }
    : reading;
}

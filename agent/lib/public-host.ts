import { isIP } from "node:net";

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
  /^22[4-9]\.|^2[3-5]\d\./, // multicast / reserved
];

/** True for hostnames that must never be fetched server-side or trusted with secrets:
 *  localhost, *.localhost, *.local, *.internal, and IP literals in private,
 *  loopback, link-local, CGNAT, or multicast ranges (IPv4 and IPv6, incl. mapped v4). */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (!h) return true;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
  const kind = isIP(h);
  if (kind === 4) return PRIVATE_V4.some((re) => re.test(h));
  if (kind === 6) {
    if (h === "::" || h === "::1") return true;
    if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true; // fe80::/10
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7
    if (h.startsWith("ff")) return true; // multicast
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return PRIVATE_V4.some((re) => re.test(mapped[1]!));
    return false;
  }
  return false;
}

/** http(s) URL whose host is public, or undefined. */
export function publicHttpUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (isPrivateHost(url.hostname)) return undefined;
  return url;
}

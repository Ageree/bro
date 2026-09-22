/**
 * Bounded downloads for inbound attachments. Nothing here logs the URL: a
 * Telegram file URL embeds the bot token.
 */

export const downloadTimeoutMs = 15_000;
/** Redirect hops followed before a chain is treated as a loop. */
const maximumRedirects = 5;
const redirectStatuses: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

export type DownloadResult =
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly mediaType: string | undefined;
    }
  | { readonly kind: "oversize" }
  | { readonly kind: "failed"; readonly reason: string };

export interface DownloadOptions extends RequestInit {
  /**
   * Decides whether a URL may be requested. Supplying it switches redirect
   * following to this module, so every hop is checked before it is fetched
   * rather than after the body has already arrived.
   */
  readonly allowUrl?: (url: URL) => boolean;
}

/**
 * Reads a response body up to `maxBytes`. A declared or observed overrun stops
 * the read instead of buffering a file the model would never receive.
 */
async function readBodyWithin(
  response: Response,
  maxBytes: number
): Promise<DownloadResult> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "oversize" };
  }
  const mediaType = response.headers.get("content-type") ?? undefined;
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maxBytes
      ? { kind: "oversize" }
      : { bytes, kind: "bytes", mediaType };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let oversize = false;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The body arrives as a sequence of chunks.
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      oversize = true;
      break;
    }
    chunks.push(value);
  }
  if (oversize) {
    await reader.cancel().catch(() => undefined);
    return { kind: "oversize" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, kind: "bytes", mediaType };
}

/**
 * The URL a redirect points at, or the reason the chain stops here. Resolving
 * it against the hop that answered keeps a relative `Location` working.
 */
function redirectTarget(
  response: Response,
  from: URL,
  allowUrl: (url: URL) => boolean
): URL | DownloadResult {
  const location = response.headers.get("location");
  const next = location === null ? null : URL.parse(location, from.href);
  if (!next) return { kind: "failed", reason: "network" };
  if (next.protocol !== "https:")
    return { kind: "failed", reason: "not-https" };
  if (!allowUrl(next)) return { kind: "failed", reason: "blocked-host" };
  return next;
}

/**
 * Downloads one HTTPS resource within the byte cap and the shared timeout. The
 * failure reasons are a fixed vocabulary so they can be logged safely.
 */
/* oxlint-disable eslint/no-await-in-loop -- A redirect chain is a sequence: each hop is checked before the next request. */
export async function downloadWithin(
  url: URL,
  maxBytes: number,
  options?: DownloadOptions
): Promise<DownloadResult> {
  const { allowUrl, ...init } = options ?? {};
  if (url.protocol !== "https:") return { kind: "failed", reason: "not-https" };
  let target = url;
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(target, {
        ...init,
        redirect: allowUrl ? "manual" : "follow",
        signal: AbortSignal.timeout(downloadTimeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "network";
      return { kind: "failed", reason };
    }
    if (allowUrl && redirectStatuses.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      if (redirects >= maximumRedirects) {
        return { kind: "failed", reason: "too-many-redirects" };
      }
      const next = redirectTarget(response, target, allowUrl);
      if (!(next instanceof URL)) return next;
      target = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "failed", reason: `http ${String(response.status)}` };
    }
    // Without `allowUrl` fetch follows redirects itself, so the body may come
    // from a different origin and scheme than the URL that was checked above.
    if (response.url.length > 0 && !response.url.startsWith("https:")) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "failed", reason: "not-https" };
    }
    try {
      return await readBodyWithin(response, maxBytes);
    } catch {
      return { kind: "failed", reason: "network" };
    }
  }
}
/* oxlint-enable eslint/no-await-in-loop */

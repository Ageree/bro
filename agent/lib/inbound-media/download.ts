/**
 * Bounded downloads for inbound attachments. Nothing here logs the URL: a
 * Telegram file URL embeds the bot token.
 */

export const downloadTimeoutMs = 15_000;

export type DownloadResult =
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly mediaType: string | undefined;
    }
  | { readonly kind: "oversize" }
  | { readonly kind: "failed"; readonly reason: string };

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
 * Downloads one HTTPS resource within the byte cap and the shared timeout. The
 * failure reasons are a fixed vocabulary so they can be logged safely.
 */
export async function downloadWithin(
  url: URL,
  maxBytes: number,
  init?: RequestInit
): Promise<DownloadResult> {
  if (url.protocol !== "https:") return { kind: "failed", reason: "not-https" };
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(downloadTimeoutMs),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "network";
    return { kind: "failed", reason };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "failed", reason: `http ${String(response.status)}` };
  }
  // fetch follows redirects, so the body may come from a different origin
  // and scheme than the URL that was checked above.
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

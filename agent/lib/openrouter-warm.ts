/** Warm the OpenRouter TLS/HTTP session during billing so the first
 *  model token does not pay a cold handshake after parkTurn. */

export const OPENROUTER_ORIGIN = "https://openrouter.ai";
export const OPENROUTER_AUTH_URL = `${OPENROUTER_ORIGIN}/api/v1/auth/key`;
export const OPENROUTER_CHAT_URL = `${OPENROUTER_ORIGIN}/api/v1/chat/completions`;
export const OPENROUTER_WARM_TIMEOUT_MS = 2_000;

let warmInflight: Promise<void> | undefined;

export function canPrefetchOpenRouter(apiKey = process.env.OPENROUTER_API_KEY): boolean {
  return Boolean(apiKey?.trim());
}

/** Fire-and-forget GET /auth/key. Same-isolate later chat calls reuse the socket. */
export function prefetchOpenRouter(): void {
  if (!canPrefetchOpenRouter()) return;
  if (warmInflight) return;
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return;
  warmInflight = fetch(OPENROUTER_AUTH_URL, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(OPENROUTER_WARM_TIMEOUT_MS),
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      warmInflight = undefined;
    });
}

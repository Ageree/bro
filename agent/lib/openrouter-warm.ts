/** Warm the OpenRouter TLS/HTTP session during billing so the first
 *  model token does not pay a cold handshake after parkTurn. */

import { withOpenRouterChatDefaults } from "./openrouter-chat.ts";

export const OPENROUTER_ORIGIN = "https://openrouter.ai";
export const OPENROUTER_AUTH_URL = `${OPENROUTER_ORIGIN}/api/v1/auth/key`;
export const OPENROUTER_CHAT_URL = `${OPENROUTER_ORIGIN}/api/v1/chat/completions`;
export const OPENROUTER_WARM_TIMEOUT_MS = 2_000;

let warmInflight: Promise<void> | undefined;

export function canPrefetchOpenRouter(apiKey = process.env.OPENROUTER_API_KEY): boolean {
  return Boolean(apiKey?.trim());
}

function warmAuth(key: string): Promise<void> {
  return fetch(OPENROUTER_AUTH_URL, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(OPENROUTER_WARM_TIMEOUT_MS),
  }).then(() => undefined);
}

/** Tiny streamed chat so the first real turn reuses the completions route, not only /auth/key. */
function warmChat(key: string): Promise<void> {
  const model = process.env.BRO_MODEL?.trim() || "z-ai/glm-5.3-flash";
  return fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      withOpenRouterChatDefaults({
        model,
        stream: true,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    ),
    signal: AbortSignal.timeout(OPENROUTER_WARM_TIMEOUT_MS),
  }).then(async (res) => {
    await res.body?.cancel().catch(() => undefined);
  });
}

/** Fire-and-forget /auth/key + a 1-token chat. Later chat calls reuse the socket. */
export function prefetchOpenRouter(): void {
  if (!canPrefetchOpenRouter()) return;
  if (warmInflight) return;
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return;
  warmInflight = Promise.allSettled([warmAuth(key), warmChat(key)])
    .then(() => undefined)
    .finally(() => {
      warmInflight = undefined;
    });
}

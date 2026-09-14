/**
 * OpenRouter chat body defaults for DeepSeek V4.1 Flash. Pure functions; the
 * fetch wrapper at the bottom rewrites the JSON body eve's AI SDK sends.
 *
 * Latency notes (2026-09-14 research, OpenRouter endpoints + Artificial
 * Analysis):
 * - This model thinks by default at effort `high`; `low` still spends ~20% of
 *   max_tokens (≈1,600 tokens) before the first visible character — about six
 *   of the seven seconds a human waited for the first bubble. `enabled: false`
 *   is the only off switch (`effort: "none"` is not in the model's supported
 *   efforts). Tool calling is unaffected.
 * - A hard `provider.order` disables OpenRouter's sticky routing, so every turn
 *   re-prefilled the 10k-token prefix on whichever host answered, and the list
 *   rots (three of four pinned hosts were down at once). Sort by latency and
 *   let the router pick; `BRO_OPENROUTER_PROVIDER_ORDER` pins a list again.
 */

export type ReasoningEffort = "low" | "high" | "max";
export type OpenRouterReasoning =
  | { enabled: false }
  | { effort: ReasoningEffort };

/** Default: no thinking phase — the first visible token is the first token. */
export const OPENROUTER_CHAT_REASONING: OpenRouterReasoning = { enabled: false };
export const OPENROUTER_CHAT_PROVIDER_SORT = "latency" as const;
/** Soft p90 cutoff (seconds): slow hosts move to the back, never excluded. */
export const OPENROUTER_CHAT_PREFERRED_MAX_LATENCY = { p90: 2.5 } as const;

const EFFORTS: readonly ReasoningEffort[] = ["low", "high", "max"];

/** `BRO_REASONING_EFFORT`: unset/`off`/`none`/`0` → thinking off; low|high|max → on. */
export function reasoningFromEnv(
  env: { BRO_REASONING_EFFORT?: string } = process.env,
): OpenRouterReasoning {
  const raw = env.BRO_REASONING_EFFORT?.trim().toLowerCase();
  if (raw && (EFFORTS as readonly string[]).includes(raw)) {
    return { effort: raw as ReasoningEffort };
  }
  return OPENROUTER_CHAT_REASONING;
}

/** `BRO_OPENROUTER_PROVIDER_ORDER=baseten,fireworks` pins hosts; empty = router picks. */
export function providerOrderFromEnv(
  env: { BRO_OPENROUTER_PROVIDER_ORDER?: string } = process.env,
): string[] | undefined {
  const raw = env.BRO_OPENROUTER_PROVIDER_ORDER?.trim();
  if (!raw) return undefined;
  const order = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return order.length > 0 ? order : undefined;
}

export type OpenRouterChatBody = {
  reasoning?: Record<string, unknown>;
  provider?: {
    sort?: string;
    order?: string[];
    preferred_max_latency?: number | Record<string, number>;
  };
  [key: string]: unknown;
};

export function isOpenRouterChatCompletionsUrl(input: RequestInfo | URL): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return url.includes("/chat/completions");
}

export function withOpenRouterChatDefaults(
  body: unknown,
  env: {
    BRO_REASONING_EFFORT?: string;
    BRO_OPENROUTER_PROVIDER_ORDER?: string;
  } = process.env,
): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const next: OpenRouterChatBody = { ...(body as OpenRouterChatBody) };
  const reasoning =
    next.reasoning && typeof next.reasoning === "object" && !Array.isArray(next.reasoning)
      ? { ...next.reasoning }
      : {};
  // An explicit effort or enabled flag from the caller wins; otherwise the env default.
  if (reasoning.effort == null && reasoning.enabled == null) {
    Object.assign(reasoning, reasoningFromEnv(env));
  }
  next.reasoning = reasoning;
  const provider =
    next.provider && typeof next.provider === "object" && !Array.isArray(next.provider)
      ? { ...next.provider }
      : {};
  const pinned = providerOrderFromEnv(env);
  if (provider.order == null && pinned) provider.order = pinned;
  // `order` and `sort` together have undocumented precedence — send one.
  if (provider.sort == null && provider.order == null) {
    provider.sort = OPENROUTER_CHAT_PROVIDER_SORT;
  }
  if (provider.preferred_max_latency == null) {
    provider.preferred_max_latency = { ...OPENROUTER_CHAT_PREFERRED_MAX_LATENCY };
  }
  next.provider = provider;
  return next;
}

export function applyOpenRouterChatDefaults(init?: RequestInit): RequestInit | undefined {
  if (!init?.body || typeof init.body !== "string") return init;
  try {
    const parsed: unknown = JSON.parse(init.body);
    return { ...init, body: JSON.stringify(withOpenRouterChatDefaults(parsed)) };
  } catch {
    return init;
  }
}

export const openRouterChatFetch: typeof fetch = (input, init) => {
  const next = isOpenRouterChatCompletionsUrl(input)
    ? applyOpenRouterChatDefaults(init)
    : init;
  return fetch(input, next);
};

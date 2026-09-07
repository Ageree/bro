/** GLM-5.3-flash reasoning cannot be turned off; the provider default is `max`. */
export const OPENROUTER_CHAT_REASONING_EFFORT = "low" as const;
export const OPENROUTER_CHAT_PROVIDER_SORT = "latency" as const;
export const OPENROUTER_CHAT_PROVIDER_ORDER = [
  "parasail",
  "together",
  "baseten",
  "novita",
] as const;
export const OPENROUTER_CHAT_PREFERRED_MAX_LATENCY = 1.5;

export type OpenRouterChatBody = {
  reasoning?: { effort?: string };
  provider?: {
    sort?: string;
    order?: string[];
    preferred_max_latency?: number;
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

export function withOpenRouterChatDefaults(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const next: OpenRouterChatBody = { ...(body as OpenRouterChatBody) };
  const reasoning =
    next.reasoning && typeof next.reasoning === "object" && !Array.isArray(next.reasoning)
      ? { ...next.reasoning }
      : {};
  if (reasoning.effort == null) reasoning.effort = OPENROUTER_CHAT_REASONING_EFFORT;
  next.reasoning = reasoning;
  const provider =
    next.provider && typeof next.provider === "object" && !Array.isArray(next.provider)
      ? { ...next.provider }
      : {};
  if (provider.sort == null) provider.sort = OPENROUTER_CHAT_PROVIDER_SORT;
  if (provider.order == null) {
    provider.order = [...OPENROUTER_CHAT_PROVIDER_ORDER];
  }
  if (provider.preferred_max_latency == null) {
    provider.preferred_max_latency = OPENROUTER_CHAT_PREFERRED_MAX_LATENCY;
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

import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import {
  directModelProvider,
  directModelProviderName,
} from "@shared/model/provider";

/** A comma-separated list of upstream host slugs, as provider routing takes them. */
function hostList(value: string | undefined) {
  return value
    ?.split(",")
    .map((slug) => slug.trim().toLowerCase())
    .filter((slug) => slug.length > 0);
}

/**
 * OpenRouter attributes traffic on its dashboard from these headers, and the
 * provider package only sets its own `X-OpenRouter-Title` variant.
 */
function openRouterAttribution() {
  return {
    "HTTP-Referer": applicationOrigin(),
    "X-Title": "Bro",
  };
}

/**
 * The backend Bro's direct model calls go to, with everything that differs
 * between the two. Both speak OpenRouter's API: RouterAI resells OpenRouter's
 * upstream hosts with the same `provider` routing, `reasoning`, `plugins`,
 * `usage.cost`, `/credits` and `/key`, so one provider package serves both
 * through `baseURL`. What differs: RouterAI bills in roubles (`usage.cost`,
 * `/credits` `data.credits`), keeps a call alive with `: PROCESSING` rather
 * than `: OPENROUTER PROCESSING`, takes no attribution headers, and returns
 * many errors with HTTP 200 (`routerai/fetch.ts`).
 *
 * A raw call (search, voice, pictures, the balance) goes to
 * `${baseURL}/<path>` with `Authorization: Bearer ${apiKey}` and `headers`.
 * `undefined` means the AI Gateway serves the model.
 */
export function modelEndpoint() {
  const provider = directModelProvider();
  const name = directModelProviderName();
  if (provider === undefined || name === undefined) return undefined;
  if (provider === "routerai") {
    if (env.ROUTERAI_API_KEY === undefined) {
      throw new Error("MODEL_PROVIDER=routerai needs ROUTERAI_API_KEY");
    }
    return {
      apiKey: env.ROUTERAI_API_KEY,
      baseURL: env.ROUTERAI_BASE_URL.replace(/\/+$/u, ""),
      contextTokens: env.ROUTERAI_MODEL_CONTEXT_TOKENS,
      costCurrency: "rub" as const,
      headers: {},
      imageModel: env.ROUTERAI_IMAGE_MODEL,
      maxOutputTokens: env.ROUTERAI_MAX_OUTPUT_TOKENS,
      model: env.ROUTERAI_MODEL,
      name,
      provider,
      providerIgnore: hostList(env.ROUTERAI_PROVIDER_IGNORE) ?? [],
      providerOrder: hostList(env.ROUTERAI_PROVIDER_ORDER),
      reasoningEffort: env.ROUTERAI_REASONING_EFFORT,
      searchModel: env.ROUTERAI_SEARCH_MODEL ?? env.ROUTERAI_MODEL,
      sttFallbackModel: env.ROUTERAI_STT_FALLBACK_MODEL,
      sttLanguage: env.ROUTERAI_STT_LANGUAGE,
      sttModel: env.ROUTERAI_STT_MODEL,
    };
  }
  if (env.OPENROUTER_API_KEY === undefined) {
    throw new Error("MODEL_PROVIDER=openrouter needs OPENROUTER_API_KEY");
  }
  return {
    apiKey: env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    contextTokens: env.OPENROUTER_MODEL_CONTEXT_TOKENS,
    costCurrency: "usd" as const,
    headers: openRouterAttribution(),
    imageModel: env.OPENROUTER_IMAGE_MODEL,
    maxOutputTokens: env.OPENROUTER_MAX_OUTPUT_TOKENS,
    model: env.OPENROUTER_MODEL,
    name,
    provider,
    providerIgnore: [],
    providerOrder: hostList(env.OPENROUTER_PROVIDER_ORDER),
    reasoningEffort: env.OPENROUTER_REASONING_EFFORT,
    searchModel: env.OPENROUTER_SEARCH_MODEL ?? env.OPENROUTER_MODEL,
    sttFallbackModel: env.OPENROUTER_STT_FALLBACK_MODEL,
    sttLanguage: env.OPENROUTER_STT_LANGUAGE,
    sttModel: env.OPENROUTER_STT_MODEL,
  };
}

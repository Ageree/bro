import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { parseLlmRoutes } from "./llm-routes.ts";
import { createRoutedFetch } from "./openrouter-fetch.ts";
import { DEFAULT_OPENROUTER_MODEL } from "./openrouter-pool.ts";

export {
  DEFAULT_MODEL_FALLBACKS,
  DEFAULT_OPENROUTER_CONTEXT_TOKENS,
  DEFAULT_OPENROUTER_MODEL,
  PAID_GLM_MODEL,
  parseModelCascade,
  parseOpenRouterKeys,
} from "./openrouter-pool.ts";
export { parseLlmRoutes } from "./llm-routes.ts";

/** Fallback output cap for OpenRouter calls when BRO_MAX_OUTPUT_TOKENS is unset/invalid. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** Positive integer parsed from BRO_MAX_OUTPUT_TOKENS, else DEFAULT_MAX_OUTPUT_TOKENS. */
export function parseMaxOutputTokens(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  const tokens = Number(trimmed);
  if (!Number.isInteger(tokens) || tokens <= 0) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  return tokens;
}

/**
 * OpenRouter reserves `max_tokens` (or the model's full completion length when
 * unset) against the account balance before running the request, then rejects
 * with HTTP 402 if the reservation exceeds the remaining balance — even when
 * the actual reply would be far smaller. Force a sane cap so an unset
 * maxOutputTokens can't reserve a model's entire (e.g. 131072-token) window.
 */
export function outputCapMiddleware(cap: number): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) =>
      params.maxOutputTokens === undefined ? { ...params, maxOutputTokens: cap } : params,
  };
}

export type BroModelEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** Model choice shared by the root agent and the worker subagent. */
export function broModel(env: BroModelEnv = process.env) {
  const routes = parseLlmRoutes(env);
  const primary = routes[0];

  if (!primary) {
    // Host already has OPENROUTER_API_KEY; AI Gateway is the fallback.
    return { model: "openai/gpt-5.4-mini" as const };
  }
  const openrouter = createOpenAI({
    apiKey: primary.keys[0],
    baseURL: primary.baseURL,
    fetch: createRoutedFetch({
      routes,
      fetch,
      onRotate: (event) => {
        console.warn("llm rotate", {
          status: event.status,
          model: event.model,
          route: event.route,
        });
      },
    }),
  });
  const cap = parseMaxOutputTokens(env.BRO_MAX_OUTPUT_TOKENS);
  const openrouterModel = wrapLanguageModel({
    model: openrouter.chat(primary.model || DEFAULT_OPENROUTER_MODEL),
    middleware: outputCapMiddleware(cap),
  });
  return primary.contextTokens !== undefined
    ? {
        model: openrouterModel,
        modelContextWindowTokens: primary.contextTokens,
      }
    : { model: openrouterModel };
}

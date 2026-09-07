import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.3-flash";
const DEFAULT_OPENROUTER_CONTEXT_TOKENS = 1_000_000;

/** Fallback output cap for OpenRouter calls when BRO_MAX_OUTPUT_TOKENS is unset/invalid. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

function parseContextTokens(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const tokens = Number(trimmed);
  if (!Number.isInteger(tokens) || tokens <= 0) {
    return undefined;
  }
  return tokens;
}

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

/** Model choice shared by the root agent and the worker subagent. */
export function broModel() {
  const model = process.env.BRO_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  const contextTokens =
    model === DEFAULT_OPENROUTER_MODEL
      ? DEFAULT_OPENROUTER_CONTEXT_TOKENS
      : parseContextTokens(process.env.BRO_MODEL_CONTEXT_TOKENS);

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    // Host already has OPENROUTER_API_KEY; AI Gateway is the fallback.
    return { model: "openai/gpt-5.4-mini" as const };
  }
  const openrouter = createOpenAI({
    apiKey: key,
    baseURL: "https://openrouter.ai/api/v1",
  });
  const cap = parseMaxOutputTokens(process.env.BRO_MAX_OUTPUT_TOKENS);
  const openrouterModel = wrapLanguageModel({
    model: openrouter.chat(model),
    middleware: outputCapMiddleware(cap),
  });
  return contextTokens !== undefined
    ? {
        model: openrouterModel,
        modelContextWindowTokens: contextTokens,
      }
    : { model: openrouterModel };
}

/** Dynamic/durable subagents must pick a serializable model id, not a provider object. */
export function broDurableModel(): {
  model: string;
  modelContextWindowTokens?: number;
} {
  if (!process.env.OPENROUTER_API_KEY) {
    return { model: "openai/gpt-5.4-mini" };
  }
  const model = process.env.BRO_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  return model === DEFAULT_OPENROUTER_MODEL
    ? { model, modelContextWindowTokens: DEFAULT_OPENROUTER_CONTEXT_TOKENS }
    : { model };
}

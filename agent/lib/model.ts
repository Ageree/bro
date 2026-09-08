import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import {
  CODEX_CONTEXT_WINDOW_TOKENS,
  DEFAULT_CODEX_MODEL,
  createCodexModel,
  withFallback,
  type CodexTokenBroker,
  type LanguageModelLike,
} from "./codex-model.ts";
import { openRouterChatFetch } from "./openrouter-chat.ts";

export {
  CODEX_CONTEXT_WINDOW_TOKENS,
  DEFAULT_CODEX_MODEL,
  createCodexModel,
  withFallback,
};
export type { CodexTokenBroker, LanguageModelLike };

export const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.3-flash";
const DEFAULT_OPENROUTER_CONTEXT_TOKENS = 1_000_000;

export const DEFAULT_ROOT_CONTEXT_TOKENS = 131_072;

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

export type BroModelOpts = {
  contextTokens?: number;
};

/** OpenRouter (or Gateway string) branch. Same shape as `broModel()`. */
export function openRouterModel(opts?: BroModelOpts) {
  const model = process.env.BRO_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  const contextTokens =
    opts?.contextTokens ??
    (model === DEFAULT_OPENROUTER_MODEL
      ? DEFAULT_OPENROUTER_CONTEXT_TOKENS
      : parseContextTokens(process.env.BRO_MODEL_CONTEXT_TOKENS));

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    // Host already has OPENROUTER_API_KEY; AI Gateway is the fallback.
    return { model: "openai/gpt-5.4-mini" as const };
  }
  const openrouter = createOpenAI({
    apiKey: key,
    baseURL: "https://openrouter.ai/api/v1",
    ...(model === DEFAULT_OPENROUTER_MODEL ? { fetch: openRouterChatFetch } : {}),
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

/** Model choice shared by the root agent and the worker subagent. */
export function broModel(opts?: BroModelOpts) {
  return openRouterModel(opts);
}

export type ChatgptModelStatus = "none" | "pending" | "connected" | "quarantined";

export type ResolveBroModelInput = {
  isGroup: boolean;
  chatgpt: ChatgptModelStatus;
};

export type ResolveBroModelOpts = BroModelOpts & {
  broker?: CodexTokenBroker;
  onFail?: (error: unknown) => unknown;
  fetch?: typeof globalThis.fetch;
};

/**
 * Group / no live Codex / missing broker → today's OpenRouter `broModel()`.
 * Connected + broker → Codex transport with OpenRouter fallback on 401/402/429.
 */
export function resolveBroModel(
  input: ResolveBroModelInput,
  opts?: ResolveBroModelOpts,
) {
  if (typeof input !== "object" || input === null) {
    throw new Error("resolveBroModel input required");
  }
  if (typeof input.isGroup !== "boolean") {
    throw new Error("isGroup must be a boolean");
  }
  if (
    input.chatgpt !== "none" &&
    input.chatgpt !== "pending" &&
    input.chatgpt !== "connected" &&
    input.chatgpt !== "quarantined"
  ) {
    throw new Error("chatgpt status is invalid");
  }
  const { broker, onFail, fetch: fetchImpl, ...broOpts } = opts ?? {};
  if (input.isGroup || input.chatgpt !== "connected" || broker === undefined) {
    return broModel(broOpts);
  }
  const fallback = broModel(broOpts);
  const primary = createCodexModel({
    model: process.env.BRO_CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL,
    broker,
    fetch: fetchImpl,
  });
  if (typeof fallback.model === "string") {
    return {
      model: primary,
      modelContextWindowTokens: CODEX_CONTEXT_WINDOW_TOKENS,
    };
  }
  return {
    model: withFallback(
      primary,
      fallback.model as unknown as LanguageModelLike,
      onFail ?? (() => undefined),
    ),
    modelContextWindowTokens: CODEX_CONTEXT_WINDOW_TOKENS,
  };
}

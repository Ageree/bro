import {
  contextTokensFor,
  parseModelCascade,
  parseOpenRouterKeys,
  splitList,
} from "./openrouter-pool.ts";

/** Official OpenAI-compatible chat endpoint Bro can call with a key you own. */
export type LlmRoute = {
  id: string;
  baseURL: string;
  keys: string[];
  model: string;
  contextTokens?: number;
};

export const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_FLASH_MODEL = "glm-4.7-flash";
export const ZAI_VISION_MODEL = "glm-4.6v-flash";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_FLASH_MODEL = "gemini-2.5-flash";
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_QWEN_MODEL = "qwen/qwen3.6-27b";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function keysFrom(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  ...names: string[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    for (const key of splitList(env[name])) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * Cheap official routes first (Z.AI Flash is permanently $0), then OpenRouter
 * `:free`. Every key must come from a signup the operator did themselves.
 */
export function parseLlmRoutes(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): LlmRoute[] {
  const routes: LlmRoute[] = [];

  const zaiKeys = keysFrom(env, "ZAI_API_KEY", "ZHIPU_API_KEY");
  if (zaiKeys.length > 0) {
    const primary = env.BRO_ZAI_MODEL?.trim() || ZAI_FLASH_MODEL;
    routes.push({
      id: "zai",
      baseURL: env.ZAI_BASE_URL?.trim() || ZAI_BASE_URL,
      keys: zaiKeys,
      model: primary,
      contextTokens: 200_000,
    });
    if (primary !== ZAI_VISION_MODEL) {
      routes.push({
        id: "zai-vision",
        baseURL: env.ZAI_BASE_URL?.trim() || ZAI_BASE_URL,
        keys: zaiKeys,
        model: ZAI_VISION_MODEL,
        contextTokens: 128_000,
      });
    }
  }

  const deepseekKeys = keysFrom(env, "DEEPSEEK_API_KEY");
  if (deepseekKeys.length > 0) {
    routes.push({
      id: "deepseek",
      baseURL: DEEPSEEK_BASE_URL,
      keys: deepseekKeys,
      model: env.BRO_DEEPSEEK_MODEL?.trim() || DEEPSEEK_FLASH_MODEL,
      contextTokens: 128_000,
    });
  }

  const geminiKeys = keysFrom(env, "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY");
  if (geminiKeys.length > 0) {
    routes.push({
      id: "gemini",
      baseURL: GEMINI_BASE_URL,
      keys: geminiKeys,
      model: env.BRO_GEMINI_MODEL?.trim() || GEMINI_FLASH_MODEL,
      contextTokens: 1_000_000,
    });
  }

  const groqKeys = keysFrom(env, "GROQ_API_KEY");
  if (groqKeys.length > 0) {
    routes.push({
      id: "groq",
      baseURL: GROQ_BASE_URL,
      keys: groqKeys,
      model: env.BRO_GROQ_MODEL?.trim() || GROQ_QWEN_MODEL,
      contextTokens: 128_000,
    });
  }

  const openrouterKeys = parseOpenRouterKeys(env);
  if (openrouterKeys.length > 0) {
    for (const model of parseModelCascade(env)) {
      const contextTokens = contextTokensFor(model, env);
      const route: LlmRoute = {
        id: `openrouter:${model}`,
        baseURL: OPENROUTER_BASE_URL,
        keys: openrouterKeys,
        model,
      };
      if (contextTokens !== undefined) route.contextTokens = contextTokens;
      routes.push(route);
    }
  }

  return routes;
}

export function chatCompletionsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/chat/completions`;
}

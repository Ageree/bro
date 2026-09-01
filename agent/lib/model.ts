import { createOpenAI } from "@ai-sdk/openai";

const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.3-flash";
const DEFAULT_OPENROUTER_CONTEXT_TOKENS = 1_000_000;

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
  return contextTokens !== undefined
    ? {
        model: openrouter.chat(model),
        modelContextWindowTokens: contextTokens,
      }
    : { model: openrouter.chat(model) };
}

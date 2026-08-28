import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.3-flash";
const DEFAULT_OPENROUTER_CONTEXT_TOKENS = 1_000_000;

const openrouterModel =
  process.env.BRO_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;

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

const isDefaultOpenrouterModel = openrouterModel === DEFAULT_OPENROUTER_MODEL;
const openrouterContextTokens = isDefaultOpenrouterModel
  ? DEFAULT_OPENROUTER_CONTEXT_TOKENS
  : parseContextTokens(process.env.BRO_MODEL_CONTEXT_TOKENS);

const openrouterKey = process.env.OPENROUTER_API_KEY;
const openrouter = openrouterKey
  ? createOpenAI({
      apiKey: openrouterKey,
      baseURL: "https://openrouter.ai/api/v1",
    })
  : null;

export default defineAgent(
  openrouter
    ? openrouterContextTokens !== undefined
      ? {
          // Host already has OPENROUTER_API_KEY; AI Gateway is optional.
          model: openrouter.chat(openrouterModel),
          modelContextWindowTokens: openrouterContextTokens,
        }
      : {
          model: openrouter.chat(openrouterModel),
        }
    : {
        model: "openai/gpt-5.4-mini",
      },
);

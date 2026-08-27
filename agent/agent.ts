import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.3-flash";
const openrouterModel =
  process.env.BRO_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;

const openrouterKey = process.env.OPENROUTER_API_KEY;
const openrouter = openrouterKey
  ? createOpenAI({
      apiKey: openrouterKey,
      baseURL: "https://openrouter.ai/api/v1",
    })
  : null;

export default defineAgent(
  openrouter
    ? {
        // Host already has OPENROUTER_API_KEY; AI Gateway is optional.
        // Custom OpenRouter ids are not in the AI Gateway catalog, so eve
        // needs an explicit window (GLM-5.3-Flash is 1M on OpenRouter).
        model: openrouter.chat(openrouterModel),
        modelContextWindowTokens: 1_000_000,
      }
    : {
        model: "openai/gpt-5.4-mini",
      },
);


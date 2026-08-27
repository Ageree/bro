import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openrouterKey = process.env.OPENROUTER_API_KEY;
const openrouter = openrouterKey
  ? createOpenAI({
      apiKey: openrouterKey,
      baseURL: "https://openrouter.ai/api/v1",
    })
  : null;

export default defineAgent({
  // Host already has OPENROUTER_API_KEY; AI Gateway is optional.
  model: openrouter
    ? openrouter.chat("gpt-4o-mini")
    : "openai/gpt-5.4-mini",
});


import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openrouterKey = process.env.OPENROUTER_API_KEY;
const openrouter = openrouterKey
  ? createOpenAI({
      apiKey: openrouterKey,
      baseURL: "https://openrouter.ai/api/v1",
    })
  : null;

// BRO_MODEL overrides; default openai/gpt-5.6-sol verified live on OpenRouter.
const modelId = process.env.BRO_MODEL ?? "openai/gpt-5.6-sol";

export default defineAgent({
  // Host already has OPENROUTER_API_KEY; AI Gateway is optional.
  // Strip openai/ so eve's compaction lookup (which prefixes openai/) finds context-window metadata.
  model: openrouter
    ? openrouter.chat(modelId.replace(/^openai\//, ""))
    : modelId,
});

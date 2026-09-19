import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { AgentModelOptionsDefinition } from "eve";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";

const applicationName = "Bro";

/**
 * OpenRouter attributes traffic on its dashboard from these headers, and the
 * provider package only sets its own `X-OpenRouter-Title` variant.
 */
function attributionHeaders() {
  return {
    "HTTP-Referer": applicationOrigin(),
    "X-Title": applicationName,
  };
}

/**
 * `OPENROUTER_PROVIDER_ORDER=baseten,fireworks` pins the upstream hosts. Left
 * unset, OpenRouter keeps its own sticky routing, which preserves the prompt
 * cache across turns.
 */
function providerRouting() {
  const order = env.OPENROUTER_PROVIDER_ORDER?.split(",")
    .map((slug) => slug.trim().toLowerCase())
    .filter((slug) => slug.length > 0);
  return order && order.length > 0 ? { order } : undefined;
}

/**
 * eve's provider-agnostic `reasoning` effort never reaches OpenRouter: the
 * provider package builds its request body from its own settings and ignores
 * that call option. Reasoning therefore travels as an OpenRouter provider
 * option, and stays off by default because DeepSeek still spends roughly 1,600
 * hidden tokens before the first visible character at the lowest effort.
 * `enabled: false` is the only switch the model honors.
 */
function reasoningOptions(): AgentModelOptionsDefinition {
  const effort = env.OPENROUTER_REASONING_EFFORT;
  if (effort === "off") {
    return {
      providerOptions: { openrouter: { reasoning: { enabled: false } } },
    };
  }
  return { providerOptions: { openrouter: { reasoning: { effort } } } };
}

/** eve model selection that calls OpenRouter directly instead of the Gateway. */
export function openRouterSelection(modelId: string) {
  const openrouter = createOpenRouter({
    apiKey: env.OPENROUTER_API_KEY,
    headers: attributionHeaders(),
  });

  return {
    model: openrouter.chat(modelId, { provider: providerRouting() }),
    // eve resolves an omitted context window from the AI Gateway catalog,
    // which does not list OpenRouter model ids.
    modelContextWindowTokens: env.OPENROUTER_MODEL_CONTEXT_TOKENS,
    modelOptions: reasoningOptions(),
  };
}

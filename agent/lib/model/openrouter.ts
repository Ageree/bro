import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
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

/**
 * How a step may use its tools: `required` must call one, `none` may only
 * write text, which ends the turn, and `auto` leaves it to the model.
 */
export type StepToolChoice = "auto" | "none" | "required";

/**
 * eve exposes no tool choice option, so a model call that must or must not
 * pick a tool gets it from middleware. A call without tools, such as
 * compaction, is left alone because `required` with nothing to call is an
 * invalid request.
 */
function toolChoiceMiddleware(
  type: Exclude<StepToolChoice, "auto">
): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      if (!params.tools?.length) return params;
      return { ...params, toolChoice: { type } };
    },
  };
}

/** eve model selection that calls OpenRouter directly instead of the Gateway. */
export function openRouterSelection(
  modelId: string,
  options: { readonly toolChoice: StepToolChoice }
) {
  const openrouter = createOpenRouter({
    apiKey: env.OPENROUTER_API_KEY,
    headers: attributionHeaders(),
  });
  const model = openrouter.chat(modelId, { provider: providerRouting() });
  // OpenRouter sends `required` to Anthropic as a forced tool call, which
  // Anthropic rejects while extended thinking is on. `none` is accepted.
  const forcedToolAllowed =
    !modelId.startsWith("anthropic/") ||
    env.OPENROUTER_REASONING_EFFORT === "off";
  const toolChoice =
    options.toolChoice === "required" && !forcedToolAllowed
      ? "auto"
      : options.toolChoice;

  return {
    model:
      toolChoice === "auto"
        ? model
        : wrapLanguageModel({
            middleware: toolChoiceMiddleware(toolChoice),
            model,
          }),
    // eve resolves an omitted context window from the AI Gateway catalog,
    // which does not list OpenRouter model ids.
    modelContextWindowTokens: env.OPENROUTER_MODEL_CONTEXT_TOKENS,
    modelOptions: reasoningOptions(),
  };
}

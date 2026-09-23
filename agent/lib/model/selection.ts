import { openRouterActive } from "@shared/model/provider";
import { openRouterSelection } from "./openrouter";

/**
 * Resolves a workspace's stored model id into what eve accepts from a
 * `step.started` resolver: a gateway model id string, or a live
 * `LanguageModel` selection when OpenRouter is the active provider. Session and
 * turn scopes must stay serializable, so the direct-provider handle can only be
 * returned per step.
 *
 * `requireToolCall` makes the step call some tool instead of ending with text.
 * Only the direct OpenRouter model can carry that, so a Gateway id string
 * ignores it and relies on the instructions and the channel fallback.
 */
export function modelSelection(
  modelId: string,
  options: { readonly requireToolCall?: boolean } = {}
) {
  return openRouterActive()
    ? openRouterSelection(modelId, {
        requireToolCall: options.requireToolCall ?? false,
      })
    : modelId;
}

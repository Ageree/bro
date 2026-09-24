import { openRouterActive } from "@shared/model/provider";
import { openRouterSelection, type StepToolChoice } from "./openrouter";

/**
 * Resolves a workspace's stored model id into what eve accepts from a
 * `step.started` resolver: a gateway model id string, or a live
 * `LanguageModel` selection when OpenRouter is the active provider. Session and
 * turn scopes must stay serializable, so the direct-provider handle can only be
 * returned per step.
 *
 * `toolChoice` makes the step call some tool (`required`) or end the turn in
 * text (`none`). Only the direct OpenRouter model can carry that, so a Gateway
 * id string ignores it and relies on the instructions, the channel fallback,
 * and `send_message` dropping repeats.
 */
export function modelSelection(
  modelId: string,
  options: { readonly toolChoice?: StepToolChoice } = {}
) {
  return openRouterActive()
    ? openRouterSelection(modelId, {
        toolChoice: options.toolChoice ?? "auto",
      })
    : modelId;
}

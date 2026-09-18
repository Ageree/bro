import { openRouterActive } from "@shared/model/provider";
import { openRouterSelection } from "./openrouter";

/**
 * Resolves a workspace's stored model id into what eve accepts from a
 * `step.started` resolver: a gateway model id string, or a live
 * `LanguageModel` selection when OpenRouter is the active provider. Session and
 * turn scopes must stay serializable, so the direct-provider handle can only be
 * returned per step.
 */
export function modelSelection(modelId: string) {
  return openRouterActive() ? openRouterSelection(modelId) : modelId;
}

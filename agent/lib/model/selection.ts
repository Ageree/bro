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
 * and `send_message` dropping repeats. `replyNote` likewise travels only
 * with the direct model; a Gateway id relies on the instructions, which carry
 * the same voice and the person's stored form of address. So does
 * `delivered`, which lets a step that says nothing after the turn's reply end
 * the turn instead of failing it, `silent`, which keeps any text of the
 * step from the person, and `withheldTools`, which a Gateway id keeps
 * offering.
 */
export function modelSelection(
  modelId: string,
  options: {
    readonly delivered?: boolean;
    readonly replyNote?: string;
    readonly silent?: boolean;
    readonly toolChoice?: StepToolChoice;
    readonly withheldTools?: readonly string[];
  } = {}
) {
  return openRouterActive()
    ? openRouterSelection(modelId, {
        delivered: options.delivered,
        replyNote: options.replyNote,
        silent: options.silent,
        toolChoice: options.toolChoice ?? "auto",
        withheldTools: options.withheldTools,
      })
    : modelId;
}

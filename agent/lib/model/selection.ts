import { directModelActive } from "@shared/model/provider";
import { directModelSelection, type StepToolChoice } from "./direct";

/**
 * Resolves a workspace's stored model id into what eve accepts from a
 * `step.started` resolver: a gateway model id string, or a live
 * `LanguageModel` selection when a direct provider (RouterAI or OpenRouter,
 * `shared/model/provider.ts`) is active. Session and
 * turn scopes must stay serializable, so the direct-provider handle can only be
 * returned per step.
 *
 * `toolChoice` makes the step call some tool (`required`) or end the turn in
 * text (`none`). Only the direct model can carry that, so a Gateway
 * id string ignores it and relies on the instructions, the channel fallback,
 * and `send_message` dropping repeats. `replyNote` likewise travels only
 * with the direct model; a Gateway id relies on the instructions, which carry
 * the same voice and the person's stored form of address. So does
 * `delivered`, which lets a step that says nothing after the turn's reply end
 * the turn instead of failing it, `silent`, which keeps any text of the
 * step from the person, and `withheldTools` and `offeredTools`, which a
 * Gateway id ignores. `stableContext`, the pilot of the cache-friendly step,
 * is never set for a Gateway id (`stepContextPilot`), nor is `skillBlocks`,
 * the skills pilot (`skillsPilot`).
 */
export function modelSelection(
  modelId: string,
  options: {
    readonly delivered?: boolean;
    readonly offeredTools?: readonly string[];
    readonly replyNote?: string;
    readonly silent?: boolean;
    readonly skillBlocks?: boolean;
    readonly stableContext?: boolean;
    readonly step?: Parameters<typeof directModelSelection>[1]["step"];
    readonly toolChoice?: StepToolChoice;
    readonly toolGroups?: Parameters<
      typeof directModelSelection
    >[1]["toolGroups"];
    readonly withheldTools?: readonly string[];
  } = {}
) {
  return directModelActive()
    ? directModelSelection(modelId, {
        delivered: options.delivered,
        offeredTools: options.offeredTools,
        replyNote: options.replyNote,
        silent: options.silent,
        skillBlocks: options.skillBlocks,
        stableContext: options.stableContext,
        step: options.step,
        toolChoice: options.toolChoice ?? "auto",
        toolGroups: options.toolGroups,
        withheldTools: options.withheldTools,
      })
    : modelId;
}

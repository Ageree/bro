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
 * the skills pilot (`skillsPilot`), nor `historyTrim`, the pilot of trimming
 * old history (`historyTrimPilot`), nor `compaction`, the pilot of compacting
 * a long conversation (`compactionPilot`), nor `reasoningOff`, the pilot of
 * the quicker answer step (`fastReplyPilot`), nor `routerGroups`, the pilot
 * of the tool router (`toolRouterListed`), nor `stagedFiles`, the files pilot
 * (`taskFilesEnabled`, which needs the direct model) with `earlierPhotos`,
 * its photos of earlier turns as lines, nor `warmConversation`,
 * which keeps RunInfra's cache warm (`promptWarmWorkspace`). `toolImages` is the
 * task agent's alone: a Gateway id leaves its tool pictures where eve put
 * them.
 */
export function modelSelection(
  modelId: string,
  options: {
    readonly compaction?: Parameters<
      typeof directModelSelection
    >[1]["compaction"];
    readonly delivered?: boolean;
    readonly earlierPhotos?: boolean;
    readonly historyTrim?: Parameters<
      typeof directModelSelection
    >[1]["historyTrim"];
    readonly offeredTools?: readonly string[];
    readonly reasoningOff?: boolean;
    readonly replyNote?: string;
    readonly routerGroups?: Parameters<
      typeof directModelSelection
    >[1]["routerGroups"];
    readonly silent?: boolean;
    readonly skillBlocks?: boolean;
    readonly stableContext?: boolean;
    readonly stagedFiles?: boolean;
    readonly step?: Parameters<typeof directModelSelection>[1]["step"];
    readonly toolChoice?: StepToolChoice;
    readonly toolGroups?: Parameters<
      typeof directModelSelection
    >[1]["toolGroups"];
    readonly toolImages?: Parameters<
      typeof directModelSelection
    >[1]["toolImages"];
    readonly warmConversation?: string;
    readonly withheldTools?: readonly string[];
  } = {}
) {
  return directModelActive()
    ? directModelSelection(modelId, {
        compaction: options.compaction,
        delivered: options.delivered,
        earlierPhotos: options.earlierPhotos,
        historyTrim: options.historyTrim,
        offeredTools: options.offeredTools,
        reasoningOff: options.reasoningOff,
        replyNote: options.replyNote,
        routerGroups: options.routerGroups,
        silent: options.silent,
        skillBlocks: options.skillBlocks,
        stableContext: options.stableContext,
        stagedFiles: options.stagedFiles,
        step: options.step,
        toolChoice: options.toolChoice ?? "auto",
        toolGroups: options.toolGroups,
        toolImages: options.toolImages,
        warmConversation: options.warmConversation,
        withheldTools: options.withheldTools,
      })
    : modelId;
}

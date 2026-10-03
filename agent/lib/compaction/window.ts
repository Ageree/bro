/**
 * The share of a step's context window at which eve compacts the
 * conversation (`compaction.thresholdPercent` in `agent/agent.ts`). eve
 * fixes it when it builds the agent, so a workspace cannot have its own.
 */
export const compactionThresholdPercent = 0.7;

/**
 * The context window a compacting step reports to eve. eve does not take a
 * threshold from a resolver: before every model call it sets it to
 * `floor(window × thresholdPercent)` of the window the step's model
 * reports (`updateCompactionThresholdForModelReference` in
 * `eve/dist/src/harness/tool-loop.js`), and nothing else in eve reads the
 * window. So a step that should compact past `inputTokens` reports the
 * window whose share is that, never more than the model's own `contextTokens`.
 * `inputTokens` is the whole input, instructions and tools included: eve
 * weighs the provider's count of the last call, plus an estimate of what
 * came after it (`shouldCompact` in `harness/compaction.js`).
 */
export function compactionWindow(contextTokens: number, inputTokens: number) {
  return Math.min(
    contextTokens,
    Math.ceil(inputTokens / compactionThresholdPercent)
  );
}

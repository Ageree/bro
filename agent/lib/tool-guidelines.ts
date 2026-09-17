/**
 * A tool's rules travel with the tool, not with the root prompt.
 *
 * `agent/instructions.md` reaches the model on every single call. Two of its
 * sections were rules ABOUT tools — «Браузер» (what Bro says around
 * `browser_task`) and «Что сказать после тула» (a result → phrase table). They
 * were written centrally, so they were paid for centrally: ~1000 estimated
 * tokens on every turn, for rules that only ever apply once a particular tool
 * is mounted and has returned a particular result.
 *
 * This module is the assembler. Each tool exports its own bullets next to its
 * `defineTool` (`eve`'s tool definition has a closed field set — description,
 * schemas, execute, approval, toModelOutput — so a guideline cannot ride on
 * the definition itself, and every file under `agent/tools/` is itself a tool,
 * so it cannot ride in a sibling data file either). `agent/instructions/tools.ts`
 * collects those exports and calls `buildToolRules` with the tools eve actually
 * mounted.
 *
 * Three properties matter, and each is asserted by `scripts/tool-guidelines-check.ts`:
 *
 *   1. DEDUPE. `browser_task` and `profile_setup` both hand back a `liveUrl`
 *      and both must say the same thing about it. Written once each, next to
 *      its own tool; emitted once, because a rule the model reads twice is a
 *      rule it can weigh twice.
 *   2. MOUNTED ONLY. A tool that is not mounted contributes nothing. Rules for
 *      a tool the model cannot call are instructions to do the impossible.
 *   3. DETERMINISTIC ORDER. Same input, same bytes. The system prompt is the
 *      cached prefix of every request; reordering it silently throws away the
 *      provider's prompt cache for the whole conversation.
 *
 * Pure by construction: no network, no Convex, no `process.env`. It takes the
 * mounted names and the guideline map and returns text, which is what lets the
 * check assemble the real block without booting the agent.
 */

/** Guideline bullets contributed by each tool, keyed by the tool's mounted name. */
export type ToolGuidelines = Record<string, readonly string[]>;

/**
 * The rules for `mounted`, as a markdown bullet list.
 *
 * Order is `mounted` order, then each tool's own bullet order, then `extra` —
 * never `Object.keys(guidelines)`, so adding a guideline for an unmounted tool
 * cannot reshuffle the block for everyone else. `extra` carries rules that
 * belong to a COMBINATION of tools rather than to any one of them (pi does the
 * same thing inside its `buildRules`), and comes last because a rule about how
 * two tools divide the work only makes sense after both have introduced
 * themselves.
 */
export function buildToolRules(
  mounted: readonly string[],
  guidelines: ToolGuidelines,
  extra?: readonly string[],
): string {
  const rules: string[] = [];
  const seen = new Set<string>();
  const add = (rule: string): void => {
    // Whitespace-insensitive identity: the same sentence indented differently
    // in two tool files is the same rule, and must still collapse to one.
    const normalized = rule.trim().replace(/\s+/g, " ");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rules.push(normalized);
  };

  for (const name of mounted) {
    for (const rule of guidelines[name] ?? []) add(rule);
  }
  for (const rule of extra ?? []) add(rule);

  return rules.map((rule) => `- ${rule}`).join("\n");
}

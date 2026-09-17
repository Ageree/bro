/**
 * `npm run budget` prints what one turn costs in prompt;
 * `npm run budget:check` asserts it has not crept back up.
 *
 * The ceiling here replaces the one `instructions:check` used to carry. That
 * one guarded a single file and was written as "baseline + 10%", which can
 * only ever ratchet upward — the repo could measure permission to grow and
 * nothing else. This one covers the whole per-turn surface (root instructions,
 * tool descriptions and schemas, skill descriptions) and ratchets DOWN: when
 * a trim lands, the new number goes in below, and nothing may climb back over
 * it without someone editing this line on purpose.
 */

import { assert } from "./lib/check.ts";
import { formatBudget, measure } from "./lib/prompt-budget.ts";

/**
 * Per-turn prompt ceiling, in estimated tokens.
 *
 * History:
 *   9142  baseline (root 5617 + tools 3398 + skill index 127). The first
 *         reading said 8365 because the tool scan counted one description per
 *         file, and `agent/tools/composio.ts` registers seven.
 *   8645  after the dedup pass, plus the Telegram-is-live caveat carried in
 *         from #116 on the main merge (see scripts/instructions-check.ts).
 *         The total moved less than the work did,
 *         because the pass spent part of what it freed:
 *           −1106  root prompt deduped (OTP, browser prose, Composio detail,
 *                  onboarding rules for turns the channel already answers)
 *           −  586 channel formatting, now one channel per turn, not both
 *           +  250 the person profile — who Bro is talking to, and the
 *                  measured style that three unactionable rules stood in for
 *         and separately −5912 on-demand, the vendored Composio SDK guide
 *         that used to land in an errand turn whenever the skill matched.
 *   8141  after the tool-guidelines pass. The root prompt lost `## Браузер`
 *         and the result→reply table (−1000) and the rules came back as a
 *         per-turn block — so the move bought structure, not budget, because
 *         every tool Bro has is mounted on every turn and "mounted only" never
 *         filters anything. The saving had to come from the TURN instead:
 *         the live-tab rules ship only while a tab is actually open, which is
 *         463 tok on an ordinary turn against 775 on a browser one.
 *
 * Lower this whenever a trim lands. Raising it is a deliberate act: a rule
 * that has to be on every single call, for every person, on every channel,
 * is rare. Situational procedure belongs in a skill (loaded on demand) or in
 * a dynamic instruction (loaded for the turns it applies to). Facts about the
 * person are the one thing worth buying room for — they are what the generic
 * rules were a substitute for.
 */
export const PER_TURN_CEILING_TOKENS = 8_200;

/** The root prompt plus its dynamic siblings: identity, voice, standing rules,
 *  the active channel's formatting, and who this person is. */
export const ROOT_INSTRUCTIONS_CEILING_TOKENS = 4_700;

function main(): void {
  const budget = measure();
  const printing = process.argv.includes("--print") || !process.argv.includes("--check");
  if (printing) console.log(formatBudget(budget));

  if (!process.argv.includes("--check")) return;

  const rootTokens = budget.entries
    .filter((e) => e.surface === "always-on")
    .reduce((n, e) => n + e.tokens, 0);

  assert(
    budget.perTurnTokens <= PER_TURN_CEILING_TOKENS,
    `per-turn prompt is ~${budget.perTurnTokens} tok, over the ${PER_TURN_CEILING_TOKENS} ceiling`,
  );
  assert(
    rootTokens <= ROOT_INSTRUCTIONS_CEILING_TOKENS,
    `root instructions are ~${rootTokens} tok, over the ${ROOT_INSTRUCTIONS_CEILING_TOKENS} ceiling`,
  );

  // A ceiling nobody is near is a ceiling nobody maintains: if the real number
  // has dropped far below it, the ceiling is stale and should be re-taken.
  assert(
    budget.perTurnTokens >= PER_TURN_CEILING_TOKENS * 0.6,
    `per-turn prompt is ~${budget.perTurnTokens} tok, far under the ${PER_TURN_CEILING_TOKENS} ceiling — re-take the ceiling in scripts/prompt-budget.ts`,
  );

  console.log(
    `prompt-budget ok — ~${budget.perTurnTokens} tok/turn (root ~${rootTokens}), ~${budget.onDemandTokens} tok on demand`,
  );
}

main();

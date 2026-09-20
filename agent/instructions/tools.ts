/**
 * The rules that belong to tools, assembled from the tools themselves.
 *
 * WHY this exists. `agent/instructions.md` is sent outside history on every
 * single model call. Two of its sections were rules about tools: «Браузер»
 * (~578 estimated tokens of what Bro says around `browser_task`) and «Что
 * сказать после тула» (~426 tokens of a result → phrase table). Written in the
 * root prompt, they were paid for by every turn — including the turns with no
 * browser, no login and no order in them — and they could only be kept honest
 * by remembering to edit a second file whenever a tool's behaviour changed.
 *
 * Now each tool exports its own bullets next to its `defineTool`
 * (`BROWSER_TASK_GUIDELINES`, `PROFILE_SETUP_GUIDELINES`, …) and this resolver
 * collects them. `buildToolRules` dedupes, keeps mounted-only, and is
 * deterministic — see `agent/lib/tool-guidelines.ts` for why each of those
 * three matters. The model still receives one flat block, so nothing about the
 * prompt's shape changed; what changed is where the sentences live and when
 * they are charged.
 *
 * WHAT STAYED IN THE ROOT PROMPT: rules that are not about a tool. «Сейф и
 * входы», «Коды», «Покупки и заказы» say what Bro may and may not do with a
 * card, a password or an order — they hold whether or not a given tool is
 * mounted, and a person hitting them has usually not called anything yet.
 *
 * prompt-budget: runtime 500 — the block is assembled from the tools' exports,
 * so this module has no literals of its own to weigh, and a per-turn cost with
 * nothing to count would otherwise read as free. The figure is the ORDINARY
 * turn (~463 tok): a turn with a live browser tab carries the extra live-tab
 * rules and comes to ~775, but that is the minority of turns and charging the
 * peak to every one of them would overstate the budget by a third.
 * `scripts/tool-guidelines-check.ts` enforces both: this cap for a chat turn
 * and its own ceiling for the live-tab turn.
 */

import { defineDynamic, defineInstructions } from "eve/instructions";
import { MOUNTED_TOOLS, toolRulesBlock } from "../lib/tool-rules.ts";
import { getTenant } from "../lib/convex";
import { tenantId } from "../lib/tenant";
import {
  cloudSessionLooksLive,
  cloudStartInFlight,
} from "../../convex/lib/browserInjectPolicy.ts";

/**
 * Is `browser_task` holding a tab open right now?
 *
 * Same condition and same tenant row `agent/instructions/jobs.ts` reads for its
 * inject steer, and `getTenant` is TTL-cached, so asking here costs no extra
 * round trip. A start still in flight counts: that is exactly the second in
 * which a follow-up («на воскресенье») arrives, and it must not be read as
 * ordinary chat.
 */
async function liveTabOpen(ctx: unknown): Promise<boolean> {
  try {
    const tenant = await getTenant(tenantId(ctx as never)).catch(() => null);
    if (!tenant) return false;
    return (
      cloudSessionLooksLive({
        status: tenant.browserStatus,
        sessionId: tenant.browserSessionId,
        runId: tenant.browserRunId,
        startedAt: tenant.browserStartedAt,
        storedTask: tenant.browserTask,
        need: (tenant as { browserNeed?: string }).browserNeed,
      }) || cloudStartInFlight({ startingAt: tenant.browserStartingAt })
    );
  } catch {
    // Unknown means "assume a tab may be open": omitting a live-tab rule while
    // a tab really is waiting costs a wrong first bubble on a code, which the
    // person sees. Shipping it needlessly costs tokens, which nobody sees.
    return true;
  }
}

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      const content = toolRulesBlock(MOUNTED_TOOLS, {
        liveTab: await liveTabOpen(ctx),
      });
      // No mounted tool brings a rule — say nothing rather than send a header
      // with an empty list under it.
      if (!content) return null;
      return defineInstructions({ role: "system", content });
    },
  },
});

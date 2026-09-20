import { defineDynamic, defineInstructions } from "eve/instructions";
import { getTenant, jobWakeRows } from "../lib/convex";
import { formatLocalNow } from "../lib/errand-context.ts";
import {
  measureStyle,
  personProfile,
  styleSamplesFromMessages,
  type PersonFacts,
} from "../lib/person-profile.ts";
import { tenantId } from "../lib/tenant";
import { resolveTenantTz } from "../../convex/lib/tzPolicy.ts";

/**
 * «Кто этот человек» — the one block that says who is on the other end.
 *
 * It is a sibling of `jobs.ts`, not a part of it, because it answers a
 * different question: jobs.ts arbitrates what Bro should DO this turn, this
 * one describes the person Bro is doing it for. Keeping them apart means a
 * Convex hiccup in one does not blank the other, and it keeps this block
 * failing quietly from having to argue with a block that must fail loudly.
 *
 * Every word the model reads lives in `agent/lib/person-profile.ts`, not here.
 * That is not only layering: `scripts/lib/prompt-budget.ts` charges a dynamic
 * instruction module for its own string literals as an upper bound, so a
 * resolver that inlines Russian prose pays for it on every single call even on
 * the turns that emit nothing. `scripts/person-profile-check.ts` asserts this
 * file stays free of prompt-sized literals.
 *
 * WHAT IS DELIBERATELY NOT HERE: the vault. `agent/lib/errand-context.ts`
 * assembles the same facts plus the delivery address, phone and email, but it
 * pays a vault-list query AND one decrypting Convex action per item. That
 * price is right in front of a Cloud browser run, which costs minutes and
 * would otherwise abort asking for a street Bro already knows. It is the wrong
 * price in front of every turn, for a fact chat almost never needs.
 * `PersonFacts` carries the address fields and `factsBlock` formats them, so a
 * caller that already holds them (or a future cached loader) can pass them
 * without touching this file.
 *
 * The job rows come from `jobWakeRows`, which is the same TTL-cached snapshot
 * `jobs.ts` reads on this very turn — so the open-errand list is free here.
 *
 * prompt-budget: runtime 250 — this block is assembled from Convex rows, so
 * it has no literals to weigh. It is charged the cap `personProfile` enforces
 * (PERSON_PROFILE_MAX_TOKENS), because a per-turn cost with nothing to count
 * would otherwise read as free.
 */

/** eve hands the dynamic-instruction hook the session history (see the note in
 *  `agent/lib/short-ack.ts`: it is `session.history`, so it holds what the
 *  person wrote BEFORE this turn, not the line that started it). That is the
 *  right window for a habit, and reading it defensively costs nothing — a
 *  shape change upstream loses the style line, never the turn. */
function historyOf(ctx: unknown): readonly unknown[] | undefined {
  const messages = (ctx as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? messages : undefined;
}

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      try {
        const phone = tenantId(ctx);
        const [tenant, rows] = await Promise.all([
          getTenant(phone).catch(() => null),
          jobWakeRows(phone).catch(() => []),
        ]);

        const facts: PersonFacts = {};
        const displayName = tenant?.displayName?.trim();
        if (displayName) facts.displayName = displayName;

        const tz = resolveTenantTz(tenant?.tz);
        const nowLocal = formatLocalNow(tz);
        if (nowLocal) {
          facts.tz = tz;
          facts.nowLocal = nowLocal;
        }

        const errands = rows
          .map((row) => row.goal?.trim())
          .filter((goal): goal is string => Boolean(goal));
        if (errands.length > 0) facts.openErrands = errands;

        const style = measureStyle(styleSamplesFromMessages(historyOf(ctx)));
        const content = personProfile({ facts, style });
        if (!content) return null;
        return defineInstructions({ role: "system", content });
      } catch {
        // Unlike jobs.ts, a failure here says NOTHING. That block carries an
        // error line on purpose — the model must not promise progress on jobs
        // it cannot see. This block only describes the person, and a prompt
        // that announces «профиль недоступен» spends tokens teaching the model
        // to talk about its own plumbing. No profile is the correct degraded
        // state: the turn proceeds exactly as it did before this shipped.
        return null;
      }
    },
  },
});

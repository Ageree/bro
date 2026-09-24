import { defineDynamic, defineInstructions } from "eve/instructions";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { listSpendEntries, readSpendLimit } from "@db/services/spending";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { localMonthKey } from "@shared/calendar/local-period";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  describeSpendRule,
  exclusionLabels,
  formatRub,
  remainingUnderRule,
  type SpendEntry,
  type SpendLimitPolicy,
  spentUnderRule,
} from "@shared/spending/limit";
import autonomy from "./content/autonomy.md?raw";

/**
 * The person's standing spend limit as it stands this month. Without it the
 * model cannot tell a purchase it may simply make from one it must ask about,
 * and falls back to asking about everything.
 */
export function spendLimitInstructions(
  policy: SpendLimitPolicy | undefined,
  entries: readonly SpendEntry[]
) {
  const excluded = exclusionLabels(policy);
  const never =
    excluded.length > 0
      ? `Без спроса никогда: ${excluded.join(", ")}.`
      : undefined;
  if (!policy || policy.rules.length === 0) {
    return [
      "Лимит трат без спроса не задан: платить без разрешения человека можно только то, что бесплатно.",
      never,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }
  return [
    "Лимит трат без спроса на этот месяц:",
    ...policy.rules.map(
      (rule) =>
        `- ${describeSpendRule(rule)}: потрачено ${formatRub(spentUnderRule(rule, entries))}, осталось ${formatRub(remainingUnderRule(rule, entries))}.`
    ),
    never,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

async function currentSpendLimit(scope: AccessScope, now: Date) {
  const [policy, timeZone] = await Promise.all([
    readSpendLimit(scope),
    readWorkspaceTimeZone(scope),
  ]);
  const entries = policy
    ? await listSpendEntries(scope, localMonthKey(now, timeZone))
    : [];
  return spendLimitInstructions(policy, entries);
}

export default defineDynamic({
  events: {
    async "turn.started"(_event, context) {
      if (
        resolveModeValue(context, {
          interactive: true,
          "scheduled-worker": true,
        }) !== true
      ) {
        return null;
      }
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      // The rules hold for every turn; the limit itself belongs to a person's
      // workspace, so a turn without one gets the rules alone.
      const limit =
        caller?.principalType === "user" &&
        z.string().safeParse(caller.attributes.workspaceId).success
          ? await currentSpendLimit(scopeFromPrincipal(caller), new Date())
          : undefined;
      return defineInstructions({
        content: limit === undefined ? autonomy : `${autonomy}\n${limit}`,
      });
    },
  },
});

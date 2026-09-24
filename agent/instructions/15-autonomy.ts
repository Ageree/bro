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
  describeStandingAction,
  formatRub,
  remainingUnderRule,
  remainingUnderStandingAction,
  type SpendEntry,
  type SpendLimitPolicy,
  spentUnderRule,
  standingActionOverridden,
} from "@shared/spending/limit";
import autonomy from "./content/autonomy.md?raw";

/**
 * The person's standing spend limit as it stands this month. Without it the
 * model cannot tell a purchase it may simply make from one it must ask about,
 * and falls back to asking about everything.
 */
export function spendLimitInstructions(
  policy: SpendLimitPolicy | undefined,
  entries: readonly SpendEntry[],
  standingEntries: readonly SpendEntry[] = []
) {
  const sites = policy?.excludedMerchants ?? [];
  const categories = policy?.excludedCategories ?? [];
  // A category is the spend limit's: standing permissions are per kind of
  // errand and no category matches them.
  const never = [
    sites.length > 0 ? `Без спроса никогда: ${sites.join(", ")}.` : undefined,
    categories.length > 0
      ? `По лимиту без спроса не оплачивай: ${categories.map((category) => `«${category}»`).join(", ")}.`
      : undefined,
  ];
  const limit =
    !policy || policy.rules.length === 0
      ? [
          "Лимит трат без спроса не задан: платить без разрешения человека можно только то, что бесплатно, и снимать нечего.",
        ]
      : [
          "Лимит трат без спроса на этот месяц:",
          ...policy.rules.map(
            (rule) =>
              `- ${describeSpendRule(rule)}: потрачено ${formatRub(spentUnderRule(rule, entries))}, осталось ${formatRub(remainingUnderRule(rule, entries))}.`
          ),
        ];
  return [
    ...limit,
    ...standingPermissionLines(policy, standingEntries),
    ...never,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/**
 * The errands the person let Bro do without a card. Without them in the
 * prompt the model asks in text about exactly what the person asked it to
 * stop asking about; and with no word that there are none, the model met
 * «без моего ок» with a revoke and a clear it had no reason to call.
 */
function standingPermissionLines(
  policy: SpendLimitPolicy | undefined,
  entries: readonly SpendEntry[]
) {
  const actions = policy?.actions ?? [];
  if (!policy || actions.length === 0) {
    return [
      "Постоянных разрешений нет: всё от имени человека идёт через карточку, снимать нечего.",
    ];
  }
  return [
    "Постоянные разрешения — когда человек сам просит такое поручение, запускай его сразу, без вопроса и без карточки (инструмент сверит сам; на отчёт браузера и в фоновой работе они не действуют):",
    ...actions.map((rule) =>
      standingActionOverridden(policy, rule)
        ? `- ${describeStandingAction(rule)} — не действует: сайт в исключениях.`
        : rule.maxRub === null
          ? `- ${describeStandingAction(rule)}.`
          : `- ${describeStandingAction(rule)}; в этом месяце осталось ${formatRub(remainingUnderStandingAction(rule, entries))}.`
    ),
  ];
}

async function currentSpendLimit(scope: AccessScope, now: Date) {
  const [policy, timeZone] = await Promise.all([
    readSpendLimit(scope),
    readWorkspaceTimeZone(scope),
  ]);
  const month = localMonthKey(now, timeZone);
  const [entries, standingEntries] = policy
    ? await Promise.all([
        listSpendEntries(scope, month),
        listSpendEntries(scope, month, { source: "standing" }),
      ])
    : [[], []];
  return spendLimitInstructions(policy, entries, standingEntries);
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

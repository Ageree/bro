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
import followThrough from "./content/follow-through.md?raw";

/**
 * The person's monthly spending budget and standing permissions. Neither
 * replaces their answer to Bro's question before each new payment.
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
    sites.length > 0
      ? `Лимит и постоянные разрешения не действуют для сайтов: ${sites.join(", ")}.`
      : undefined,
    categories.length > 0
      ? `Лимит не действует для категорий: ${categories.map((category) => `«${category}»`).join(", ")}.`
      : undefined,
  ];
  // «Снимать нечего» holds only with neither a budget nor paid permissions.
  const paidPermissions = (policy?.actions ?? []).some(
    (rule) => rule.maxRub !== null
  );
  const limit =
    !policy || policy.rules.length === 0
      ? [
          paidPermissions
            ? "Лимита трат на месяц нет, но ниже есть платные постоянные разрешения с потолком. Они не заменяют вопрос «Оплачиваю?» перед каждой новой оплатой; «ничего не оплачивай без моего ок» снимает их одним `spend_limit` с `clear` без магазина и категории."
            : "Лимит трат на месяц и платные постоянные разрешения не заданы: перед каждой новой оплатой всё равно спроси «Оплачиваю?» и дождись «да»; снимать нечего.",
        ]
      : [
          "Бюджет трат на этот месяц (не разрешение платить без вопроса):",
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
      "Постоянных разрешений нет, снимать нечего: что человек сам просит — делай сразу, а перед оплатой спроси «Оплачиваю?».",
    ];
  }
  return [
    "Постоянные разрешения — когда человек сам просит такое поручение, запускай его сразу без карточки: бесплатное делай без вопроса, платное доведи до итоговой суммы и перед каждой новой оплатой или привязкой карты спроси «Оплачиваю?» и дождись «да». Лимит и потолок этого не заменяют; на отчёт браузера и в фоновой работе разрешения не действуют:",
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
      // Setting up the later step of an errand is the conversation's: a
      // scheduled worker has no schedule tools and must not say it set one.
      const followThroughRules = resolveModeValue(context, {
        interactive: followThrough,
      });
      return defineInstructions({
        content: [autonomy, followThroughRules, limit]
          .filter((part) => part !== null && part !== undefined)
          .join("\n"),
      });
    },
  },
});

import { Meter, Row, Rows, Section } from "@web/components/paper/document";
import { Badge } from "@web/components/ui/badge";
import {
  describeSpendRule,
  describeStandingAction,
  formatRub,
  remainingUnderRule,
  remainingUnderStandingAction,
  type SpendEntry,
  type SpendLimitPolicy,
  spentUnderRule,
  spentUnderStandingAction,
  type StandingAction,
  standingActionExclusions,
  standingActionOverridden,
  standingMonthCapRub,
} from "@shared/spending/limit";

/**
 * One standing permission as it holds today: what it lets through, what its
 * month has spent, and the excluded sites it does not act on — all of it,
 * when the site it names is excluded.
 */
function StandingPermissionRow({
  entries,
  policy,
  rule,
}: {
  readonly entries: readonly SpendEntry[];
  readonly policy: SpendLimitPolicy;
  readonly rule: StandingAction;
}) {
  const overridden = standingActionOverridden(policy, rule);
  const except = overridden ? [] : standingActionExclusions(policy, rule);
  const paid = rule.maxRub !== null;
  const spent = spentUnderStandingAction(rule, entries);
  return (
    <Row
      side={
        overridden
          ? "не действует"
          : paid
            ? `осталось ${formatRub(remainingUnderStandingAction(rule, entries))}`
            : undefined
      }
    >
      <p>{describeStandingAction(rule)}</p>
      {overridden ? (
        <p className="type-status text-muted-foreground">
          Сайт в исключениях: без спроса Bro там ничего не делает.
        </p>
      ) : null}
      {except.length > 0 ? (
        <p className="type-status text-muted-foreground">
          Кроме: {except.join(", ")}
        </p>
      ) : null}
      {paid && !overridden ? (
        <>
          <p className="type-status text-muted-foreground">
            В этом месяце потрачено {formatRub(spent)}
          </p>
          <Meter allowance={standingMonthCapRub(rule)} used={spent} />
        </>
      ) : null}
    </Row>
  );
}

const noEntries: readonly SpendEntry[] = [];

/**
 * What Bro may do without asking, as it stands this month: the limit to pay
 * without asking, the errands it does without a card, and what it never does
 * on its own. It is set in the chat, in the person's own words, so the
 * cabinet only shows it: what is allowed, what is spent, what is left.
 * Excluded sites hold for both; excluded categories only for the limit,
 * since a standing permission is given per kind of errand.
 */
export function SpendLimitSection({
  entries,
  policy,
  standingEntries = noEntries,
}: {
  readonly entries: readonly SpendEntry[];
  readonly policy: SpendLimitPolicy | undefined;
  /** The month's payments made on standing permissions. */
  readonly standingEntries?: readonly SpendEntry[];
}) {
  const rules = policy?.rules ?? [];
  const actions = policy?.actions ?? [];
  const excludedSites = policy?.excludedMerchants ?? [];
  const excludedCategories = policy?.excludedCategories ?? [];

  return (
    <Section
      headingId="spend-limit-heading"
      state={rules.length > 0 || actions.length > 0 ? "Включены" : "Не заданы"}
      title="Траты без спроса"
    >
      {rules.length > 0 ? (
        <Rows>
          {rules.map((rule) => {
            const spent = spentUnderRule(rule, entries);
            return (
              <Row
                key={`${rule.merchant ?? ""}:${rule.category ?? ""}`}
                side={`осталось ${formatRub(remainingUnderRule(rule, entries))}`}
              >
                <p>{describeSpendRule(rule)}</p>
                <p className="type-status text-muted-foreground">
                  В этом месяце потрачено {formatRub(spent)}
                </p>
                <Meter allowance={rule.limitRub} used={spent} />
              </Row>
            );
          })}
        </Rows>
      ) : actions.length > 0 ? (
        <p className="type-fine text-muted-foreground">
          Лимита трат без спроса нет: без подтверждения Bro платит только по
          разрешениям ниже, в их пределах.
        </p>
      ) : (
        <p className="type-fine text-muted-foreground">
          Без спроса Bro оформляет только бесплатное. Напиши ему «можешь тратить
          до 3000 ₽ без спроса» — и он будет сам оплачивать покупки в этих
          пределах и присылать чек.
        </p>
      )}
      {policy && actions.length > 0 ? (
        <div className="mt-[0.6rem]">
          <p className="type-fine text-muted-foreground">Без подтверждения:</p>
          <Rows>
            {actions.map((rule) => (
              <StandingPermissionRow
                entries={standingEntries}
                key={`${rule.kind ?? ""}:${rule.merchant ?? ""}`}
                policy={policy}
                rule={rule}
              />
            ))}
          </Rows>
        </div>
      ) : null}
      {excludedSites.length > 0 ? (
        <div className="mt-[0.6rem] flex flex-wrap items-center gap-2">
          <span className="type-fine text-muted-foreground">
            Никогда без спроса:
          </span>
          {excludedSites.map((site) => (
            <Badge key={site} variant="outline">
              {site}
            </Badge>
          ))}
        </div>
      ) : null}
      {excludedCategories.length > 0 ? (
        <div className="mt-[0.6rem] flex flex-wrap items-center gap-2">
          <span className="type-fine text-muted-foreground">
            Не оплачивать по лимиту:
          </span>
          {excludedCategories.map((category) => (
            <Badge key={category} variant="outline">
              «{category}»
            </Badge>
          ))}
        </div>
      ) : null}
      <p className="type-fine mt-[0.6rem] text-muted-foreground">
        Подписки, платежи не в рублях и сборы сверх остатка Bro всегда согласует
        с тобой. Изменить или снять лимит и разрешения — напиши ему в чат.
      </p>
    </Section>
  );
}

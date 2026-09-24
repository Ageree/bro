import { Meter, Row, Rows, Section } from "@web/components/paper/document";
import { Badge } from "@web/components/ui/badge";
import {
  describeSpendRule,
  describeStandingAction,
  exclusionLabels,
  formatRub,
  remainingUnderRule,
  type SpendEntry,
  type SpendLimitPolicy,
  spentUnderRule,
} from "@shared/spending/limit";

/**
 * What Bro may do without asking, as it stands this month: the limit to pay
 * without asking, the errands it does without a card, and what it never does
 * on its own. It is set in the chat, in the person's own words, so the
 * cabinet only shows it: what is allowed, what is spent, what is left.
 */
export function SpendLimitSection({
  entries,
  policy,
}: {
  readonly entries: readonly SpendEntry[];
  readonly policy: SpendLimitPolicy | undefined;
}) {
  const rules = policy?.rules ?? [];
  const actions = policy?.actions ?? [];
  const excluded = exclusionLabels(policy);

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
      ) : (
        <p className="type-fine text-muted-foreground">
          Без спроса Bro оформляет только бесплатное. Напиши ему «можешь тратить
          до 3000 ₽ без спроса» — и он будет сам оплачивать покупки в этих
          пределах и присылать чек.
        </p>
      )}
      {actions.length > 0 ? (
        <div className="mt-[0.6rem]">
          <p className="type-fine text-muted-foreground">Без подтверждения:</p>
          <ul className="mt-1 flex flex-col gap-1">
            {actions.map((rule) => (
              <li key={`${rule.kind ?? ""}:${rule.merchant ?? ""}`}>
                {describeStandingAction(rule)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {excluded.length > 0 ? (
        <div className="mt-[0.6rem] flex flex-wrap items-center gap-2">
          <span className="type-fine text-muted-foreground">
            Никогда без спроса:
          </span>
          {excluded.map((label) => (
            <Badge key={label} variant="outline">
              {label}
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

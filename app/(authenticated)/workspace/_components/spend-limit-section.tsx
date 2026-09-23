import { Meter, Row, Rows, Section } from "@web/components/paper/document";
import { Badge } from "@web/components/ui/badge";
import {
  describeSpendRule,
  exclusionLabels,
  formatRub,
  remainingUnderRule,
  type SpendEntry,
  type SpendLimitPolicy,
  spentUnderRule,
} from "@shared/spending/limit";

/**
 * The standing permission to pay without asking, as it stands this month.
 * It is set in the chat, in the person's own words, so the cabinet only shows
 * it: what is allowed, what is spent, what is left and what is never paid.
 */
export function SpendLimitSection({
  entries,
  policy,
}: {
  readonly entries: readonly SpendEntry[];
  readonly policy: SpendLimitPolicy | undefined;
}) {
  const rules = policy?.rules ?? [];
  const excluded = exclusionLabels(policy);

  return (
    <Section
      headingId="spend-limit-heading"
      state={rules.length > 0 ? "Включены" : "Не заданы"}
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
        с тобой. Изменить или снять лимит — напиши ему в чат.
      </p>
    </Section>
  );
}

import { z } from "zod";

/**
 * The standing permission a person gives with «можешь тратить до N ₽ без
 * спроса»: how much Bro may pay per calendar month without asking first,
 * optionally narrowed to one merchant or one category, and what it must never
 * pay for on its own. Amounts are whole roubles — a spending ceiling has no use
 * for kopecks, and rounding the exposure up keeps every comparison on the safe
 * side.
 */
export const spendLimitCurrency = "RUB";

const merchantSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z0-9-]+$/u, "A merchant is a bare host name.");

const labelSchema = z.string().trim().toLowerCase().min(1).max(60);

const spendRuleSchema = z.object({
  category: labelSchema.nullable(),
  limitRub: z.number().int().positive().max(10_000_000),
  merchant: merchantSchema.nullable(),
});

// A shop and a category are excluded separately: a category called «example»
// must not block every payment to a host that ends in `.example`.
export const spendLimitPolicySchema = z.object({
  currency: z.literal(spendLimitCurrency),
  excludedCategories: z.array(labelSchema).max(50),
  excludedMerchants: z.array(merchantSchema).max(50),
  rules: z.array(spendRuleSchema).max(20),
  version: z.literal(1),
});

export type SpendRule = z.infer<typeof spendRuleSchema>;
export type SpendLimitPolicy = z.infer<typeof spendLimitPolicySchema>;

/** What a payment is filed under: the shop it goes to and what it is for. */
export interface SpendTarget {
  readonly category: string | null;
  readonly merchant: string | null;
}

/** One auto-paid errand as it counts against the month. */
export interface SpendEntry extends SpendTarget {
  readonly amountRub: number;
  readonly feeRub: number;
}

/**
 * `https://www.ozon.ru/cart` and `ozon.ru` are the same merchant. Anything
 * that is not a host name is not a merchant the limit can be scoped to.
 */
export function normalizeMerchant(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) return null;
  const url = URL.parse(text.includes("://") ? text : `https://${text}`);
  if (!url) return null;
  const host = url.hostname;
  const parsed = merchantSchema.safeParse(host.replace(/^www\./u, ""));
  return parsed.success ? parsed.data : null;
}

export function normalizeCategory(value: string | null | undefined) {
  const parsed = labelSchema.safeParse(value ?? "");
  return parsed.success ? parsed.data : null;
}

/** A rule for `ozon.ru` covers `pay.ozon.ru` too; the reverse does not hold. */
function merchantCovers(ruleMerchant: string, merchant: string | null) {
  return (
    merchant !== null &&
    (merchant === ruleMerchant || merchant.endsWith(`.${ruleMerchant}`))
  );
}

/** A rule without a merchant or a category is the general monthly limit. */
function ruleApplies(rule: SpendRule, target: SpendTarget) {
  if (rule.merchant !== null && !merchantCovers(rule.merchant, target.merchant))
    return false;
  if (rule.category !== null && rule.category !== target.category) return false;
  return true;
}

export function sameRuleScope(rule: SpendRule, target: SpendTarget) {
  return rule.merchant === target.merchant && rule.category === target.category;
}

/**
 * What an entry takes out of the month: the charge plus any fee that can still
 * land later — a no-show or cancellation penalty is money the person may pay
 * for a decision Bro made.
 */
function entryExposureRub(entry: SpendEntry) {
  return entry.amountRub + entry.feeRub;
}

export function spentUnderRule(
  rule: SpendRule,
  entries: readonly SpendEntry[]
) {
  return entries
    .filter((entry) => ruleApplies(rule, entry))
    .reduce((sum, entry) => sum + entryExposureRub(entry), 0);
}

export function remainingUnderRule(
  rule: SpendRule,
  entries: readonly SpendEntry[]
) {
  return Math.max(0, rule.limitRub - spentUnderRule(rule, entries));
}

/**
 * What is left for a payment to this target: the tightest of the rules that
 * cover it, or nothing when no rule does.
 */
export function remainingForTarget(
  policy: SpendLimitPolicy,
  target: SpendTarget,
  entries: readonly SpendEntry[]
) {
  const covering = policy.rules.filter((rule) => ruleApplies(rule, target));
  if (covering.length === 0) return undefined;
  return Math.min(...covering.map((rule) => remainingUnderRule(rule, entries)));
}

function isExcluded(policy: SpendLimitPolicy, target: SpendTarget) {
  return (
    (target.category !== null &&
      policy.excludedCategories.includes(target.category)) ||
    policy.excludedMerchants.some((merchant) =>
      merchantCovers(merchant, target.merchant)
    )
  );
}

/** Every exclusion as the person reads it: shops first, then categories. */
export function exclusionLabels(policy: SpendLimitPolicy | undefined) {
  if (!policy) return [];
  return [
    ...policy.excludedMerchants,
    ...policy.excludedCategories.map((category) => `«${category}»`),
  ];
}

/** A decimal or an overstated amount is rounded up, never down. */
export function wholeRubles(amount: number) {
  return Math.max(0, Math.ceil(amount - 1e-9));
}

export interface AutoPaymentRequest extends SpendTarget {
  /** What the checkout charges now, in the checkout's currency. */
  readonly amount: number;
  readonly currency: string;
  /** A non-refundable fee, deposit or cancellation penalty on top of it. */
  readonly fee: number;
  /** A subscription, an auto-renewal or any other repeating charge. */
  readonly recurring: boolean;
}

export type AutoPaymentDecision =
  | { readonly allowed: true; readonly basis: "free" }
  | {
      readonly allowed: true;
      readonly basis: "limit";
      readonly exposureRub: number;
      readonly remainingAfterRub: number;
    }
  | {
      readonly allowed: false;
      readonly reason:
        | "currency"
        | "excluded"
        | "no_limit"
        | "no_rule"
        | "over_limit"
        | "recurring";
      readonly remainingRub?: number;
    };

/**
 * Whether Bro may pay for this without asking. Free is free: a booking that
 * charges nothing and can be cancelled for nothing needs no limit at all. A
 * payment has to fit every rule that covers it — the merchant's or category's
 * own ceiling and the general one alike — so a narrow rule never widens what
 * the person allowed overall. A subscription is never Bro's to start, and an
 * exclusion is never overridden.
 */
export function decideAutoPayment(
  policy: SpendLimitPolicy | undefined,
  request: AutoPaymentRequest,
  entries: readonly SpendEntry[]
): AutoPaymentDecision {
  if (request.recurring) return { allowed: false, reason: "recurring" };
  if (policy && isExcluded(policy, request)) {
    return { allowed: false, reason: "excluded" };
  }
  const exposureRub = wholeRubles(request.amount) + wholeRubles(request.fee);
  if (exposureRub === 0) return { allowed: true, basis: "free" };
  if (!policy) return { allowed: false, reason: "no_limit" };
  if (request.currency.trim().toUpperCase() !== policy.currency) {
    return { allowed: false, reason: "currency" };
  }
  const remainingRub = remainingForTarget(policy, request, entries);
  if (remainingRub === undefined) return { allowed: false, reason: "no_rule" };
  if (exposureRub > remainingRub) {
    return { allowed: false, reason: "over_limit", remainingRub };
  }
  return {
    allowed: true,
    basis: "limit",
    exposureRub,
    remainingAfterRub: remainingRub - exposureRub,
  };
}

const rubFormatter = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 0,
});

export function formatRub(amount: number) {
  return `${rubFormatter.format(amount)} ₽`;
}

/** «до 5 000 ₽ в месяц на ozon.ru» — how a rule reads to the person. */
export function describeSpendRule(rule: SpendRule) {
  const scope = [
    rule.merchant ? `на ${rule.merchant}` : undefined,
    rule.category ? `на «${rule.category}»` : undefined,
  ].filter((part) => part !== undefined);
  return [`до ${formatRub(rule.limitRub)} в месяц`, ...scope].join(" ");
}

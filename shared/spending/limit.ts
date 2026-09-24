import { z } from "zod";
import { browserSubmissionKinds } from "@shared/browser/submission";

/**
 * Everything a person has let Bro do without asking, in one policy. The
 * spend limit they give with «можешь тратить до N ₽ без спроса»: how much Bro
 * may pay per calendar month, optionally narrowed to one merchant or one
 * category. The standing permissions they give with «бронируй столики сам» or
 * «в Лавке заказывай без подтверждения до 3000 ₽»: a kind of errand, a site or
 * both that Bro does in their name without an approval card, with a ceiling
 * per errand for the paid ones. And what it must never do on its own. Amounts
 * are whole roubles — a spending ceiling has no use for kopecks, and rounding
 * the exposure up keeps every comparison on the safe side.
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

const standingActionKindSchema = z
  .enum(browserSubmissionKinds)
  .exclude(["other"]);

/**
 * One standing permission. A rule without a ceiling covers only what is free:
 * binding the card, even as a guarantee, needs a ceiling the person named.
 */
const standingActionSchema = z
  .object({
    kind: standingActionKindSchema.nullable(),
    maxRub: z.number().int().positive().max(10_000_000).nullable(),
    merchant: merchantSchema.nullable(),
  })
  .refine((rule) => rule.kind !== null || rule.merchant !== null, {
    message: "A standing permission names a kind of errand, a site or both.",
  });

// A shop and a category are excluded separately: a category called «example»
// must not block every payment to a host that ends in `.example`.
export const spendLimitPolicySchema = z.object({
  currency: z.literal(spendLimitCurrency),
  excludedCategories: z.array(labelSchema).max(50),
  excludedMerchants: z.array(merchantSchema).max(50),
  rules: z.array(spendRuleSchema).max(20),
  // Written after the limit itself: a policy saved before standing
  // permissions existed has none.
  actions: z.array(standingActionSchema).max(30).optional(),
  version: z.literal(1),
});

export type SpendRule = z.infer<typeof spendRuleSchema>;
export type StandingAction = z.infer<typeof standingActionSchema>;
export type StandingActionKind = z.infer<typeof standingActionKindSchema>;
export const standingActionKinds = standingActionKindSchema.options;
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

/**
 * Whether `outer` covers everything `inner` covers. Every payment counted
 * against `inner` then counts against `outer` too, so an outer rule with a
 * limit no higher always leaves no more than the inner one does.
 */
function ruleContains(outer: SpendRule, inner: SpendRule) {
  return (
    (outer.merchant === null ||
      merchantCovers(outer.merchant, inner.merchant)) &&
    (outer.category === null || outer.category === inner.category)
  );
}

/**
 * Whether a policy change lets Bro do more without asking anywhere: pay more
 * on the monthly limit, or act in the person's name on an errand no standing
 * permission covered before.
 */
export function policyWidens(
  before: SpendLimitPolicy | undefined,
  after: SpendLimitPolicy
) {
  return spendRulesWiden(before, after) || actionsWiden(before, after);
}

/**
 * Whether a policy change lets Bro pay more anywhere, judged with the same
 * coverage the payment decision uses — a rule for `ozon.ru` also binds
 * `pay.ozon.ru`. For every shop and category the policies name, before or
 * after, the change widens when permission appears where there was none (a
 * new rule, a lifted exclusion), or when a ceiling that bound the target is
 * gone or higher and no rule at least as broad, with a limit no higher, still
 * binds it. That holds whatever the month has spent, so no spending can make
 * a change judged narrowing pay more.
 */
function spendRulesWiden(
  before: SpendLimitPolicy | undefined,
  after: SpendLimitPolicy
) {
  const rulesBefore = before?.rules ?? [];
  const policies = before ? [before, after] : [after];
  // A merchant nothing names is bound only by the rules without a merchant,
  // exactly like no merchant at all; the same goes for categories.
  const merchants = new Set<string | null>([null]);
  const categories = new Set<string | null>([null]);
  for (const policy of policies) {
    for (const rule of policy.rules) {
      merchants.add(rule.merchant);
      categories.add(rule.category);
    }
    for (const merchant of policy.excludedMerchants) merchants.add(merchant);
    for (const category of policy.excludedCategories) categories.add(category);
  }
  return [...merchants].some((merchant) =>
    [...categories].some((category) => {
      const target = { category, merchant };
      const bound = after.rules.filter((rule) => ruleApplies(rule, target));
      if (bound.length === 0 || isExcluded(after, target)) return false;
      const bindingBefore = rulesBefore.filter((rule) =>
        ruleApplies(rule, target)
      );
      if (!before || bindingBefore.length === 0 || isExcluded(before, target)) {
        return true;
      }
      return bindingBefore.some(
        (old) =>
          !bound.some(
            (rule) => ruleContains(rule, old) && rule.limitRub <= old.limitRub
          )
      );
    })
  );
}

function actionKindCovers(
  rule: StandingAction,
  kind: StandingActionKind | "other" | null
) {
  return rule.kind === null || rule.kind === kind;
}

function actionMerchantCovers(rule: StandingAction, merchant: string | null) {
  return rule.merchant === null || merchantCovers(rule.merchant, merchant);
}

/**
 * Whether the policy lets Bro act on errands of this kind (any kind when
 * null) on this site without a card, paying up to `capRub` on each.
 */
function actionAllows(
  policy: SpendLimitPolicy,
  kind: StandingActionKind | null,
  merchant: string | null,
  capRub: number
) {
  if (isExcluded(policy, { category: null, merchant })) return false;
  return (policy.actions ?? []).some(
    (rule) =>
      actionKindCovers(rule, kind) &&
      actionMerchantCovers(rule, merchant) &&
      (rule.maxRub ?? 0) >= capRub
  );
}

/**
 * Whether the change lets Bro act without a card somewhere it could not, or
 * pay more per errand there: for every site either policy names, and for a
 * site none names, each rule after the change must already be allowed before
 * it — for the same kinds, with a ceiling at least as high. Lifting an
 * exclusion under an existing rule widens the same way.
 */
function actionsWiden(
  before: SpendLimitPolicy | undefined,
  after: SpendLimitPolicy
) {
  const policies = before ? [before, after] : [after];
  const merchants = new Set<string | null>([null]);
  for (const policy of policies) {
    for (const rule of policy.actions ?? []) merchants.add(rule.merchant);
    for (const merchant of policy.excludedMerchants) merchants.add(merchant);
  }
  return (after.actions ?? []).some((rule) =>
    [...merchants].some(
      (merchant) =>
        actionMerchantCovers(rule, merchant) &&
        !isExcluded(after, { category: null, merchant }) &&
        !(
          before !== undefined &&
          actionAllows(before, rule.kind, merchant, rule.maxRub ?? 0)
        )
    )
  );
}

export interface StandingActionRequest {
  /** What the errand costs in roubles, when it is paid. */
  readonly chargeRub: number | undefined;
  readonly kind: StandingActionKind | "other";
  readonly merchant: string | null;
  /** The errand binds the card, whatever it costs. */
  readonly paying: boolean;
  /** A subscription or any other repeating charge. */
  readonly recurring: boolean;
}

/**
 * Whether a standing permission lets Bro do this errand in the person's name
 * without a card, and the most it may pay on it. A free errand needs a rule
 * for its kind or its site; a paid one also needs the rule's ceiling to hold
 * its cost, and then the run may pay up to that ceiling. A site the person
 * excluded and a repeating charge always go back to the card.
 */
export function decideStandingAction(
  policy: SpendLimitPolicy | undefined,
  request: StandingActionRequest
) {
  if (!policy) return undefined;
  if (isExcluded(policy, { category: null, merchant: request.merchant })) {
    return undefined;
  }
  const paying = request.paying || request.chargeRub !== undefined;
  if (paying && request.recurring) return undefined;
  const charge = wholeRubles(request.chargeRub ?? 0);
  const [rule] = (policy.actions ?? [])
    .filter(
      (candidate) =>
        actionKindCovers(candidate, request.kind) &&
        actionMerchantCovers(candidate, request.merchant) &&
        (!paying || (candidate.maxRub !== null && charge <= candidate.maxRub))
    )
    .toSorted((left, right) => (right.maxRub ?? 0) - (left.maxRub ?? 0));
  if (!rule) return undefined;
  return { capRub: paying ? (rule.maxRub ?? 0) : undefined, rule };
}

export function sameActionScope(
  rule: StandingAction,
  scope: Pick<StandingAction, "kind" | "merchant">
) {
  return rule.kind === scope.kind && rule.merchant === scope.merchant;
}

/** How each kind of errand reads to the person. */
const standingActionLabels: Record<StandingActionKind, string> = {
  appointment: "записи к врачам и на услуги",
  application: "заявления и заявки",
  booking: "брони жилья, билетов и аренды",
  job_application: "отклики на вакансии",
  message: "сообщения и заявки исполнителям",
  order: "заказы товаров и еды",
  table: "брони столиков",
  taxi: "заказы такси",
};

/** «заказы такси без спроса, до 1 500 ₽ за раз» — how a permission reads. */
export function describeStandingAction(rule: StandingAction) {
  const what = rule.kind === null ? "всё" : standingActionLabels[rule.kind];
  return [
    `${what} без спроса`,
    rule.merchant === null ? undefined : `на ${rule.merchant}`,
    rule.maxRub === null
      ? "только бесплатное"
      : `до ${formatRub(rule.maxRub)} за раз`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
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
  | {
      readonly allowed: true;
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
 * Whether Bro may bind the card and pay for this without asking. Only a limit
 * the person set and that covers this shop and category allows it — a card
 * guarantee that charges nothing today binds the card all the same, so a
 * zero total is no permission of its own. A payment has to fit every rule
 * that covers it — the merchant's or category's own ceiling and the general
 * one alike — so a narrow rule never widens what the person allowed overall.
 * The limit is in roubles and so is the total it allows. A subscription is
 * never Bro's to start, and an exclusion is never overridden.
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
  if (!policy) return { allowed: false, reason: "no_limit" };
  if (request.currency.trim().toUpperCase() !== policy.currency) {
    return { allowed: false, reason: "currency" };
  }
  const remainingRub = remainingForTarget(policy, request, entries);
  if (remainingRub === undefined) return { allowed: false, reason: "no_rule" };
  const exposureRub = wholeRubles(request.amount) + wholeRubles(request.fee);
  if (exposureRub > remainingRub) {
    return { allowed: false, reason: "over_limit", remainingRub };
  }
  return {
    allowed: true,
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

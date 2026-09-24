import { describe, expect, it } from "vitest";
import {
  type AutoPaymentRequest,
  decideAutoPayment,
  normalizeCategory,
  normalizeMerchant,
  remainingForTarget,
  remainingUnderRule,
  type SpendEntry,
  type SpendLimitPolicy,
  spentUnderRule,
  wholeRubles,
} from "./limit";

function policy(overrides: Partial<SpendLimitPolicy> = {}): SpendLimitPolicy {
  return {
    currency: "RUB",
    excludedCategories: [],
    excludedMerchants: [],
    rules: [{ category: null, limitRub: 5000, merchant: null }],
    version: 1,
    ...overrides,
  };
}

function payment(
  overrides: Partial<AutoPaymentRequest> = {}
): AutoPaymentRequest {
  return {
    amount: 1500,
    category: "еда",
    currency: "RUB",
    fee: 0,
    merchant: "shop.example",
    recurring: false,
    ...overrides,
  };
}

const groceries: SpendEntry = {
  amountRub: 1200,
  category: "еда",
  feeRub: 0,
  merchant: "shop.example",
};
const taxi: SpendEntry = {
  amountRub: 600,
  category: "такси",
  feeRub: 200,
  merchant: "taxi.example",
};

describe("spend limit arithmetic", () => {
  it("counts a fee that can still land against the month", () => {
    const general = { category: null, limitRub: 5000, merchant: null };

    expect(spentUnderRule(general, [groceries, taxi])).toBe(2000);
    expect(remainingUnderRule(general, [groceries, taxi])).toBe(3000);
  });

  it("counts only what a narrow rule covers", () => {
    const taxiRule = { category: "такси", limitRub: 1000, merchant: null };
    const shopRule = {
      category: null,
      limitRub: 3000,
      merchant: "shop.example",
    };

    expect(spentUnderRule(taxiRule, [groceries, taxi])).toBe(800);
    expect(remainingUnderRule(taxiRule, [groceries, taxi])).toBe(200);
    expect(spentUnderRule(shopRule, [groceries, taxi])).toBe(1200);
  });

  it("never reports a negative remainder", () => {
    const small = { category: null, limitRub: 1000, merchant: null };

    expect(remainingUnderRule(small, [groceries, taxi])).toBe(0);
  });

  it("takes the tightest covering rule as what is left", () => {
    const rules = [
      { category: null, limitRub: 5000, merchant: null },
      { category: "такси", limitRub: 1000, merchant: null },
    ];

    expect(
      remainingForTarget(
        policy({ rules }),
        { category: "такси", merchant: "taxi.example" },
        [groceries, taxi]
      )
    ).toBe(200);
    expect(
      remainingForTarget(
        policy({
          rules: [{ category: "такси", limitRub: 1000, merchant: null }],
        }),
        { category: "кино", merchant: null },
        []
      )
    ).toBeUndefined();
  });

  it("rounds amounts up to whole roubles", () => {
    expect(wholeRubles(1499.01)).toBe(1500);
    expect(wholeRubles(1500)).toBe(1500);
    expect(wholeRubles(-3)).toBe(0);
  });

  it("files a site under its bare host and a category in lower case", () => {
    expect(normalizeMerchant("https://www.Ozon.ru/cart?x=1")).toBe("ozon.ru");
    expect(normalizeMerchant("pay.ozon.ru")).toBe("pay.ozon.ru");
    expect(normalizeMerchant("озон")).toBeNull();
    expect(normalizeMerchant(undefined)).toBeNull();
    expect(normalizeCategory("  Еда ")).toBe("еда");
    expect(normalizeCategory("")).toBeNull();
  });
});

describe("the auto-payment decision", () => {
  it("pays within what is left of the month", () => {
    expect(decideAutoPayment(policy(), payment(), [groceries])).toEqual({
      allowed: true,
      exposureRub: 1500,
      remainingAfterRub: 2300,
    });
  });

  it("asks when the payment is more than what is left", () => {
    expect(
      decideAutoPayment(policy(), payment({ amount: 3900 }), [groceries])
    ).toEqual({ allowed: false, reason: "over_limit", remainingRub: 3800 });
  });

  it("allows exactly the remainder", () => {
    const decision = decideAutoPayment(policy(), payment({ amount: 3800 }), [
      groceries,
    ]);

    expect(decision).toMatchObject({ allowed: true, remainingAfterRub: 0 });
  });

  it("counts a non-refundable fee on top of the charge", () => {
    // A free table with a no-show penalty is a decision that can cost money.
    expect(
      decideAutoPayment(policy(), payment({ amount: 0, fee: 3801 }), [
        groceries,
      ])
    ).toMatchObject({ allowed: false, reason: "over_limit" });
    expect(
      decideAutoPayment(policy(), payment({ amount: 1000, fee: 500 }), [])
    ).toMatchObject({ allowed: true, exposureRub: 1500 });
  });

  it("never binds the card for a free booking without a limit that covers it", () => {
    // A card guarantee charges nothing today and still puts the card on file.
    const guarantee = payment({ amount: 0, fee: 0 });

    expect(decideAutoPayment(undefined, guarantee, [])).toEqual({
      allowed: false,
      reason: "no_limit",
    });
    expect(
      decideAutoPayment(
        policy({
          rules: [
            { category: null, limitRub: 3000, merchant: "other.example" },
          ],
        }),
        guarantee,
        []
      )
    ).toEqual({ allowed: false, reason: "no_rule" });
    expect(decideAutoPayment(policy(), guarantee, [])).toEqual({
      allowed: true,
      exposureRub: 0,
      remainingAfterRub: 5000,
    });
  });

  it("asks for any paid purchase when no limit is set", () => {
    expect(decideAutoPayment(undefined, payment(), [])).toEqual({
      allowed: false,
      reason: "no_limit",
    });
  });

  it("never starts a subscription on its own, however cheap", () => {
    expect(
      decideAutoPayment(policy(), payment({ amount: 0, recurring: true }), [])
    ).toEqual({ allowed: false, reason: "recurring" });
  });

  it("never pays an excluded merchant or category", () => {
    const excluded = policy({
      excludedCategories: ["алкоголь"],
      excludedMerchants: ["shop.example"],
    });

    expect(
      decideAutoPayment(excluded, payment({ merchant: "pay.shop.example" }), [])
    ).toEqual({ allowed: false, reason: "excluded" });
    expect(
      decideAutoPayment(
        excluded,
        payment({ category: "алкоголь", merchant: "other.example" }),
        []
      )
    ).toEqual({ allowed: false, reason: "excluded" });
  });

  it("keeps a category exclusion from matching a shop's host", () => {
    // Excluding the category «example» says nothing about shop.example.
    const excluded = policy({ excludedCategories: ["example"] });

    expect(
      decideAutoPayment(excluded, payment({ category: "еда" }), [])
    ).toMatchObject({ allowed: true });
  });

  it("asks when the checkout is in another currency", () => {
    expect(
      decideAutoPayment(policy(), payment({ currency: "usd" }), [])
    ).toEqual({ allowed: false, reason: "currency" });
    // $50 is well under 5 000 as a number and still not the person's roubles.
    expect(
      decideAutoPayment(policy(), payment({ amount: 50, currency: "USD" }), [])
    ).toEqual({ allowed: false, reason: "currency" });
    expect(
      decideAutoPayment(policy(), payment({ amount: 0, currency: "EUR" }), [])
    ).toEqual({ allowed: false, reason: "currency" });
  });

  it("asks when no rule covers the merchant", () => {
    const shopOnly = policy({
      rules: [{ category: null, limitRub: 3000, merchant: "shop.example" }],
    });

    expect(
      decideAutoPayment(shopOnly, payment({ merchant: "other.example" }), [])
    ).toEqual({ allowed: false, reason: "no_rule" });
    expect(decideAutoPayment(shopOnly, payment(), [])).toMatchObject({
      allowed: true,
    });
  });

  it("holds a narrow rule and the general one at the same time", () => {
    const both = policy({
      rules: [
        { category: null, limitRub: 5000, merchant: null },
        { category: "такси", limitRub: 1000, merchant: null },
      ],
    });
    const ride = payment({ amount: 300, category: "такси" });

    // 800 of the taxi thousand are gone, so 300 more does not fit even though
    // the general limit has room.
    expect(decideAutoPayment(both, ride, [taxi])).toEqual({
      allowed: false,
      reason: "over_limit",
      remainingRub: 200,
    });
    // And a large general spend caps the taxi rule from above.
    expect(
      decideAutoPayment(both, payment({ amount: 150, category: "такси" }), [
        { ...groceries, amountRub: 4900 },
      ])
    ).toEqual({ allowed: false, reason: "over_limit", remainingRub: 100 });
  });
});

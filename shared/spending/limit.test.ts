import { describe, expect, it } from "vitest";
import {
  attemptPolicyChange,
  type AutoPaymentRequest,
  decideAutoPayment,
  decideStandingAction,
  describeStandingAction,
  formatRub,
  normalizeCategory,
  normalizeMerchant,
  policyWidens,
  spendLimitPolicySchema,
  standingActionExclusions,
  standingActionMaxRub,
  standingActionOverridden,
  standingActionsReaching,
  standingActionWithin,
  standingMonthCapRub,
  remainingForTarget,
  remainingUnderRule,
  type SpendEntry,
  type SpendLimitPolicy,
  spentUnderRule,
  type StandingActionRequest,
  wholeRubles,
  withdrawnPermissions,
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
/** A standing permission to order taxis anywhere, up to 1 500 ₽ a ride. */
const taxiRides = { kind: "taxi" as const, maxRub: 1500, merchant: null };

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

describe("whether a policy change widens what Bro may pay", () => {
  const rules = (...list: SpendLimitPolicy["rules"]) => policy({ rules: list });
  const general = { category: null, limitRub: 5000, merchant: null };
  const ozon = { category: null, limitRub: 100, merchant: "ozon.ru" };
  const payOzon = { category: null, limitRub: 5000, merchant: "pay.ozon.ru" };
  const food = { category: "еда", limitRub: 1000, merchant: null };

  it("widens when a new permission appears or a limit goes up", () => {
    expect(policyWidens(undefined, rules(general))).toBe(true);
    expect(
      policyWidens(rules(general), rules({ ...general, limitRub: 6000 }))
    ).toBe(true);
    expect(
      policyWidens(
        policy({ excludedMerchants: ["wb.ru"] }),
        policy({ excludedMerchants: [] })
      )
    ).toBe(true);
  });

  it("follows subdomains the way payments do", () => {
    // Without ozon.ru at 100 ₽, pay.ozon.ru answers only to its own 5 000 ₽.
    expect(policyWidens(rules(ozon, payOzon), rules(payOzon))).toBe(true);
    // Without pay.ozon.ru, ozon.ru's 100 ₽ still binds it.
    expect(policyWidens(rules(ozon, payOzon), rules(ozon))).toBe(false);
  });

  it("widens when a crossing ceiling goes, whatever the limits say", () => {
    // A rule for ozon.ru does not contain one for «еда»: food bought on ozon.ru
    // with the food month nearly spent would get the whole ozon.ru limit.
    const ozonAtThousand = { ...ozon, limitRub: 1000 };
    expect(
      policyWidens(rules(food, ozonAtThousand), rules(ozonAtThousand))
    ).toBe(true);
  });

  it("asks before dropping a parent ceiling even when the child's limit is lower", () => {
    // The smallest limit stays 100 ₽ either way, but what is left does not:
    // with 4 950 ₽ spent elsewhere on ozon.ru, pay.ozon.ru has 50 ₽ before
    // the clear and 100 ₽ after it.
    const parent = { category: null, limitRub: 5000, merchant: "ozon.ru" };
    const child = { category: null, limitRub: 100, merchant: "pay.ozon.ru" };
    const spentElsewhere: SpendEntry = {
      amountRub: 4950,
      category: null,
      feeRub: 0,
      merchant: "market.ozon.ru",
    };
    const request = payment({
      amount: 80,
      category: null,
      merchant: "pay.ozon.ru",
    });

    expect(
      decideAutoPayment(rules(parent, child), request, [spentElsewhere])
    ).toMatchObject({ allowed: false, remainingRub: 50 });
    expect(
      decideAutoPayment(rules(child), request, [spentElsewhere])
    ).toMatchObject({ allowed: true });
    expect(policyWidens(rules(parent, child), rules(child))).toBe(true);
  });

  it("narrows by lowering, adding a narrower ceiling, or clearing everything", () => {
    expect(
      policyWidens(rules(general), rules({ ...general, limitRub: 3000 }))
    ).toBe(false);
    expect(policyWidens(rules(general), rules(general, ozon))).toBe(false);
    expect(policyWidens(rules(general, ozon), rules())).toBe(false);
    expect(
      policyWidens(rules(general), policy({ excludedCategories: ["еда"] }))
    ).toBe(false);
  });

  it("never widens by taking permissions back, from nothing or from any policy", () => {
    const lavka = {
      kind: "order" as const,
      maxRub: 3000,
      merchant: "lavka.yandex.ru",
    };
    const before = policy({
      actions: [taxiRides, lavka],
      excludedMerchants: ["wb.ru"],
      rules: [general, ozon],
    });
    expect(policyWidens(undefined, policy({ rules: [] }))).toBe(false);
    expect(policyWidens(before, { ...before, actions: [lavka] })).toBe(false);
    expect(policyWidens(before, { ...before, actions: [] })).toBe(false);
    expect(policyWidens(before, { ...before, actions: [], rules: [] })).toBe(
      false
    );
  });
});

describe("what still holds after a permission is taken back", () => {
  const goYandex = {
    chargeRub: 900,
    kind: "taxi" as const,
    merchant: "go.yandex.ru",
    paying: true,
    recurring: false,
  };

  it("names exactly the permissions that still let such an errand through", () => {
    const anywhere = policy({ actions: [taxiRides] });
    const scope = { kind: "taxi" as const, merchant: "go.yandex.ru" };

    // The permission for every site is not inside the named site…
    expect(standingActionWithin(taxiRides, scope)).toBe(false);
    // …so a ride there still goes without a card, and it is named.
    expect(decideStandingAction(anywhere, goYandex)).toBeDefined();
    expect(standingActionsReaching(anywhere, scope)).toEqual([taxiRides]);
    // An excluded site is reached by nothing, as a ride there needs a card.
    const excluded = policy({
      actions: [taxiRides],
      excludedMerchants: ["go.yandex.ru"],
    });
    expect(decideStandingAction(excluded, goYandex)).toBeUndefined();
    expect(standingActionsReaching(excluded, scope)).toEqual([]);
  });

  it("counts a site's subdomains inside it", () => {
    const lavka = {
      kind: "order" as const,
      maxRub: 3000,
      merchant: "lavka.yandex.ru",
    };
    expect(
      standingActionWithin(lavka, { kind: null, merchant: "yandex.ru" })
    ).toBe(true);
    expect(
      standingActionWithin(lavka, { kind: "taxi", merchant: "yandex.ru" })
    ).toBe(false);
  });
});

describe("a policy change as the person reads it", () => {
  const tables = { kind: "table" as const, maxRub: null, merchant: null };

  it("keeps a change the store accepts, and says why it cannot make another", () => {
    expect(attemptPolicyChange(() => policy())).toEqual({ policy: policy() });
    expect(
      attemptPolicyChange(() => {
        throw new Error("A merchant is its site or host name.");
      })
    ).toEqual({ reason: "A merchant is its site or host name." });
    const refused = attemptPolicyChange(() =>
      policy({ actions: [{ ...taxiRides, monthRub: 1000 }] })
    );
    expect("reason" in refused ? refused.reason : "").toContain(
      "at least its ceiling"
    );
  });

  it("names what a change took back, not what it only re-priced", () => {
    const before = policy({ actions: [tables, taxiRides] });

    expect(
      withdrawnPermissions(before, policy({ actions: [tables], rules: [] }))
    ).toEqual({
      permissions: [describeStandingAction(taxiRides)],
      rules: [`до ${formatRub(5000)} в месяц`],
    });
    expect(
      withdrawnPermissions(
        before,
        policy({ actions: [tables, { ...taxiRides, maxRub: 1000 }] })
      )
    ).toEqual({ permissions: [], rules: [] });
    expect(withdrawnPermissions(undefined, undefined)).toEqual({
      permissions: [],
      rules: [],
    });
  });
});

function standingRequest(
  overrides: Partial<StandingActionRequest> = {}
): StandingActionRequest {
  return {
    chargeRub: undefined,
    kind: "table",
    merchant: "cafe-pushkin.ru",
    paying: false,
    recurring: false,
    ...overrides,
  };
}

/** A standing-permission taxi payment this month. */
function taxiEntry(amountRub: number): SpendEntry {
  return { amountRub, category: "taxi", feeRub: 0, merchant: "taxi.yandex.ru" };
}

describe("standing permissions", () => {
  const actions = (...list: NonNullable<SpendLimitPolicy["actions"]>) =>
    policy({ actions: list });
  const tables = { kind: "table" as const, maxRub: null, merchant: null };
  const taxiRule = { kind: "taxi" as const, maxRub: 1500, merchant: null };
  const lavka = {
    kind: "order" as const,
    maxRub: 3000,
    merchant: "lavka.yandex.ru",
  };
  const general = { category: null, limitRub: 5000, merchant: null };

  it("covers a free errand of the kind on any site, held to that site", () => {
    expect(decideStandingAction(actions(tables), standingRequest())).toEqual({
      capRub: undefined,
      host: "cafe-pushkin.ru",
      rule: tables,
    });
  });

  it("holds a site's permission to that site, not the errand's subdomain", () => {
    expect(
      decideStandingAction(
        actions({ kind: null, maxRub: null, merchant: "yandex.ru" }),
        standingRequest({ merchant: "eda.yandex.ru" })
      )
    ).toMatchObject({ host: "yandex.ru" });
  });

  it("never covers an errand without a site to hold it to", () => {
    expect(
      decideStandingAction(actions(tables), standingRequest({ merchant: null }))
    ).toBeUndefined();
  });

  it("covers a paid errand under the ceiling and pays up to that ceiling", () => {
    expect(
      decideStandingAction(
        actions(taxiRule),
        standingRequest({
          chargeRub: 900,
          kind: "taxi",
          merchant: "taxi.yandex.ru",
        })
      )
    ).toEqual({ capRub: 1500, host: "taxi.yandex.ru", rule: taxiRule });
    expect(
      decideStandingAction(
        actions(lavka),
        standingRequest({
          chargeRub: 2990,
          kind: "order",
          merchant: "lavka.yandex.ru",
        })
      )
    ).toMatchObject({ capRub: 3000 });
  });

  it("does not cover another kind, another site or a higher cost", () => {
    for (const other of [
      standingRequest({ kind: "appointment" }),
      standingRequest({ chargeRub: 2400, kind: "taxi" }),
      standingRequest({ chargeRub: 500, kind: "order", merchant: "ozon.ru" }),
      // A free-only permission never binds the card, not even as a guarantee.
      standingRequest({ chargeRub: 0 }),
      standingRequest({ paying: true }),
    ]) {
      expect(
        decideStandingAction(actions(tables, taxiRule, lavka), other)
      ).toBeUndefined();
    }
    expect(decideStandingAction(undefined, standingRequest())).toBeUndefined();
  });

  it("never covers a subscription, even one that costs nothing today", () => {
    for (const request of [
      standingRequest({ recurring: true }),
      standingRequest({ kind: "order", recurring: true }),
    ]) {
      expect(
        decideStandingAction(
          actions(tables, { kind: "order", maxRub: null, merchant: null }),
          request
        )
      ).toBeUndefined();
    }
  });

  it("pays only while the permission's month has room for its ceiling", () => {
    const ride = standingRequest({
      chargeRub: 900,
      kind: "taxi",
      merchant: "taxi.yandex.ru",
    });
    // Three rides at the ceiling by default: 4 500 ₽ a month.
    expect(standingMonthCapRub(taxiRule)).toBe(4500);
    expect(
      decideStandingAction(actions(taxiRule), ride, [
        taxiEntry(1500),
        taxiEntry(1500),
      ])
    ).toMatchObject({ capRub: 1500 });
    expect(
      decideStandingAction(actions(taxiRule), ride, [
        taxiEntry(1500),
        taxiEntry(1500),
        taxiEntry(700),
      ])
    ).toBeUndefined();
    // A month the person named holds instead; another kind's payments do
    // not count against it.
    expect(
      decideStandingAction(actions({ ...taxiRule, monthRub: 20_000 }), ride, [
        taxiEntry(15_000),
        { ...taxiEntry(9000), category: "order" },
      ])
    ).toMatchObject({ capRub: 1500 });
    // A free errand takes nothing from the month.
    expect(
      decideStandingAction(actions(tables), standingRequest(), [
        { ...taxiEntry(99_999), category: "table" },
      ])
    ).toMatchObject({ capRub: undefined });
  });

  it("never covers an excluded site or a repeating charge", () => {
    expect(
      decideStandingAction(
        policy({ actions: [taxiRule], excludedMerchants: ["gett.com"] }),
        standingRequest({ chargeRub: 500, kind: "taxi", merchant: "gett.com" })
      )
    ).toBeUndefined();
    expect(
      decideStandingAction(
        actions(lavka),
        standingRequest({
          chargeRub: 299,
          kind: "order",
          merchant: "lavka.yandex.ru",
          recurring: true,
        })
      )
    ).toBeUndefined();
  });

  it("lets a permission for a whole site cover every kind there and on its subdomains", () => {
    const site = { kind: null, maxRub: 5000, merchant: "ozon.ru" };
    expect(
      decideStandingAction(
        actions(site),
        standingRequest({
          chargeRub: 1200,
          kind: "other",
          merchant: "pay.ozon.ru",
        })
      )
    ).toMatchObject({ capRub: 5000 });
    expect(
      decideStandingAction(
        actions(site),
        standingRequest({
          chargeRub: 1200,
          kind: "other",
          merchant: "ozon.com",
        })
      )
    ).toBeUndefined();
  });

  it("reads to the person as what, where and up to how much", () => {
    expect(describeStandingAction(tables)).toBe(
      "брони столиков без спроса, на любых сайтах, только бесплатное"
    );
    expect(describeStandingAction(lavka)).toBe(
      `заказы товаров и еды без спроса, на lavka.yandex.ru, до ${formatRub(3000)} за раз и до ${formatRub(9000)} в месяц`
    );
  });

  it("refuses a permission or a limit for a shared hosting suffix", () => {
    for (const host of [
      "tilda.ws",
      "spb.ru",
      "pages.dev",
      "github.io",
      "gov.ru",
    ]) {
      expect(normalizeMerchant(`https://${host}/`)).toBeNull();
      expect(
        spendLimitPolicySchema.safeParse(
          policy({ actions: [{ kind: "table", maxRub: null, merchant: host }] })
        ).success
      ).toBe(false);
      expect(
        spendLimitPolicySchema.safeParse(
          policy({
            rules: [{ category: null, limitRub: 1000, merchant: host }],
          })
        ).success
      ).toBe(false);
    }
    // A site under the suffix is one owner, and one merchant.
    expect(normalizeMerchant("https://cafe.tilda.ws")).toBe("cafe.tilda.ws");
    expect(normalizeMerchant("https://lkfl2.nalog.gov.ru/")).toBe(
      "lkfl2.nalog.gov.ru"
    );
  });

  it("caps what one permission may cost", () => {
    expect(standingActionMaxRub).toBe(30_000);
    expect(
      spendLimitPolicySchema.safeParse(
        policy({ actions: [{ ...taxiRule, maxRub: 30_001 }] })
      ).success
    ).toBe(false);
    expect(
      spendLimitPolicySchema.safeParse(
        policy({ actions: [{ ...taxiRule, monthRub: 1000 }] })
      ).success
    ).toBe(false);
  });

  it("names the excluded sites a permission skips, never a category", () => {
    const excluded = policy({
      actions: [taxiRule, lavka],
      excludedCategories: ["такси"],
      excludedMerchants: ["gett.com", "lavka.yandex.ru"],
    });
    expect(standingActionExclusions(excluded, taxiRule)).toEqual([
      "gett.com",
      "lavka.yandex.ru",
    ]);
    expect(standingActionOverridden(excluded, taxiRule)).toBe(false);
    expect(standingActionOverridden(excluded, lavka)).toBe(true);
  });

  it("widens with a new permission, a higher ceiling or a lifted exclusion", () => {
    expect(policyWidens(undefined, actions(tables))).toBe(true);
    expect(policyWidens(actions(taxiRule), actions(taxiRule, tables))).toBe(
      true
    );
    expect(
      policyWidens(actions(taxiRule), actions({ ...taxiRule, maxRub: 2000 }))
    ).toBe(true);
    expect(
      policyWidens(actions(lavka), actions({ ...lavka, merchant: null }))
    ).toBe(true);
    expect(
      policyWidens(
        policy({ actions: [taxiRule], excludedMerchants: ["gett.com"] }),
        actions(taxiRule)
      )
    ).toBe(true);
    expect(
      policyWidens(actions(taxiRule), actions({ ...taxiRule, monthRub: 9000 }))
    ).toBe(true);
  });

  it("narrows by revoking, lowering a ceiling or narrowing to one site", () => {
    expect(policyWidens(actions(taxiRule, tables), actions(tables))).toBe(
      false
    );
    expect(
      policyWidens(actions(taxiRule), actions({ ...taxiRule, maxRub: 1000 }))
    ).toBe(false);
    expect(
      policyWidens(actions({ ...lavka, merchant: null }), actions(lavka))
    ).toBe(false);
    // Taking the permissions away leaves the monthly limit as it was.
    expect(
      policyWidens(
        policy({ actions: [taxiRule], rules: [general] }),
        policy({ rules: [general] })
      )
    ).toBe(false);
  });
});

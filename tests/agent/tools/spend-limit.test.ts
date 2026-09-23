import { describe, expect, it } from "vitest";
import {
  applySpendLimitChange,
  spendLimitApproval,
} from "@agent/tools/spend_limit";

const monthly = {
  currency: "RUB" as const,
  excludedCategories: [],
  excludedMerchants: [],
  rules: [{ category: null, limitRub: 5000, merchant: null }],
  version: 1 as const,
};

describe("spend_limit changes", () => {
  it("sets a general monthly limit from nothing", () => {
    expect(
      applySpendLimitChange(undefined, { action: "set", limitRub: 3000 })
    ).toEqual({ ...monthly, rules: [{ ...monthly.rules[0], limitRub: 3000 }] });
  });

  it("replaces the rule of the same scope and adds a narrower one beside it", () => {
    const raised = applySpendLimitChange(monthly, {
      action: "set",
      limitRub: 7000,
    });
    const withShop = applySpendLimitChange(raised, {
      action: "set",
      limitRub: 2000,
      merchant: "https://www.ozon.ru/",
    });

    expect(withShop.rules).toEqual([
      { category: null, limitRub: 7000, merchant: null },
      { category: null, limitRub: 2000, merchant: "ozon.ru" },
    ]);
  });

  it("clears one scope, or every rule while keeping the exclusions", () => {
    const policy = {
      ...monthly,
      excludedCategories: ["алкоголь"],
      rules: [
        ...monthly.rules,
        { category: "такси", limitRub: 1000, merchant: null },
      ],
    };

    expect(
      applySpendLimitChange(policy, { action: "clear", category: "Такси" })
        .rules
    ).toEqual(monthly.rules);
    expect(applySpendLimitChange(policy, { action: "clear" })).toEqual({
      ...policy,
      rules: [],
    });
  });

  it("excludes and re-includes a shop or a category once, each in its own list", () => {
    const excluded = applySpendLimitChange(
      applySpendLimitChange(
        applySpendLimitChange(monthly, {
          action: "exclude",
          merchant: "wb.ru",
        }),
        { action: "exclude", merchant: "https://wb.ru" }
      ),
      { action: "exclude", category: "Алкоголь" }
    );
    expect(excluded.excludedMerchants).toEqual(["wb.ru"]);
    expect(excluded.excludedCategories).toEqual(["алкоголь"]);
    const included = applySpendLimitChange(excluded, {
      action: "include",
      merchant: "wb.ru",
    });
    expect(included.excludedMerchants).toEqual([]);
    expect(included.excludedCategories).toEqual(["алкоголь"]);
  });

  it("refuses a set without an amount, a merchant that is not a host or a blank category", () => {
    expect(() => applySpendLimitChange(monthly, { action: "set" })).toThrow(
      "Set needs the monthly amount in roubles."
    );
    expect(() =>
      applySpendLimitChange(monthly, {
        action: "set",
        limitRub: 100,
        merchant: "озон",
      })
    ).toThrow("site or host name");
    // A blank category would otherwise turn a narrow rule into the general one.
    expect(() =>
      applySpendLimitChange(monthly, {
        action: "set",
        category: "   ",
        limitRub: 100,
      })
    ).toThrow("non-empty word");
    expect(() => applySpendLimitChange(monthly, { action: "exclude" })).toThrow(
      "Name the shop or the category"
    );
  });

  it("asks the person to confirm only what widens the permission", () => {
    // A new rule, and a higher one, let Bro pay more.
    expect(
      spendLimitApproval({ action: "set", limitRub: 3000 }, undefined)
    ).toBe("user-approval");
    expect(spendLimitApproval({ action: "set", limitRub: 7000 }, monthly)).toBe(
      "user-approval"
    );
    expect(
      spendLimitApproval(
        { action: "set", limitRub: 1000, merchant: "ozon.ru" },
        monthly
      )
    ).toBe("user-approval");
    expect(
      spendLimitApproval({ action: "include", merchant: "wb.ru" }, monthly)
    ).toBe("user-approval");
    // Lowering or keeping a rule, clearing, excluding and reading only take
    // permission away or change nothing.
    expect(spendLimitApproval({ action: "set", limitRub: 3000 }, monthly)).toBe(
      "not-applicable"
    );
    expect(spendLimitApproval({ action: "set", limitRub: 5000 }, monthly)).toBe(
      "not-applicable"
    );
    expect(spendLimitApproval({ action: "clear" }, monthly)).toBe(
      "not-applicable"
    );
    expect(
      spendLimitApproval({ action: "exclude", category: "еда" }, monthly)
    ).toBe("not-applicable");
    expect(spendLimitApproval({ action: "read" }, monthly)).toBe(
      "not-applicable"
    );
    // Clearing a rule nothing else stands above takes its permission away.
    expect(
      spendLimitApproval(
        { action: "clear", merchant: "ozon.ru" },
        {
          ...monthly,
          rules: [{ category: null, limitRub: 500, merchant: "ozon.ru" }],
        }
      )
    ).toBe("not-applicable");
    // A set that cannot be read is treated as widening.
    expect(
      spendLimitApproval(
        { action: "set", limitRub: 100, merchant: "озон" },
        monthly
      )
    ).toBe("user-approval");
  });

  it("asks before clearing a ceiling that sits under a broader rule", () => {
    // 5 000 ₽ overall and 500 ₽ on ozon.ru: clearing the ozon.ru rule lifts
    // ozon.ru to 5 000 ₽.
    const withShop = {
      ...monthly,
      rules: [
        ...monthly.rules,
        { category: null, limitRub: 500, merchant: "ozon.ru" },
      ],
    };
    expect(
      applySpendLimitChange(withShop, {
        action: "clear",
        merchant: "https://www.ozon.ru/",
      }).rules
    ).toEqual(monthly.rules);
    expect(
      spendLimitApproval(
        { action: "clear", merchant: "https://www.ozon.ru/" },
        withShop
      )
    ).toBe("user-approval");

    // A category rule crossing a shop rule is a ceiling on their overlap too.
    const crossing = {
      ...monthly,
      rules: [
        { category: "еда", limitRub: 3000, merchant: null },
        { category: null, limitRub: 500, merchant: "ozon.ru" },
      ],
    };
    expect(
      spendLimitApproval({ action: "clear", merchant: "ozon.ru" }, crossing)
    ).toBe("user-approval");
    // Clearing everything leaves nothing to pay under.
    expect(spendLimitApproval({ action: "clear" }, withShop)).toBe(
      "not-applicable"
    );
    // A clear that cannot be checked against the policy is treated as widening.
    expect(
      spendLimitApproval({ action: "clear", merchant: "озон" }, withShop)
    ).toBe("user-approval");
  });
});

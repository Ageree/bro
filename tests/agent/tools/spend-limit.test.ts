import { describe, expect, it } from "vitest";
import {
  applySpendLimitChange,
  spendLimitApproval,
} from "@agent/tools/spend_limit";

const monthly = {
  currency: "RUB" as const,
  excluded: [],
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
      excluded: ["алкоголь"],
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

  it("excludes and re-includes a shop or a category once", () => {
    const excluded = applySpendLimitChange(
      applySpendLimitChange(monthly, { action: "exclude", merchant: "wb.ru" }),
      { action: "exclude", merchant: "https://wb.ru" }
    );
    expect(excluded.excluded).toEqual(["wb.ru"]);
    expect(
      applySpendLimitChange(excluded, { action: "include", merchant: "wb.ru" })
        .excluded
    ).toEqual([]);
  });

  it("refuses a set without an amount or a merchant that is not a host", () => {
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
    expect(() => applySpendLimitChange(monthly, { action: "exclude" })).toThrow(
      "Name the shop or the category"
    );
  });

  it("asks the person to confirm only what widens the permission", () => {
    expect(spendLimitApproval({ action: "set", limitRub: 5000 })).toBe(
      "user-approval"
    );
    expect(spendLimitApproval({ action: "include", merchant: "wb.ru" })).toBe(
      "user-approval"
    );
    expect(spendLimitApproval({ action: "clear" })).toBe("not-applicable");
    expect(spendLimitApproval({ action: "exclude", category: "еда" })).toBe(
      "not-applicable"
    );
    expect(spendLimitApproval({ action: "read" })).toBe("not-applicable");
  });
});

import { describe, expect, it } from "vitest";
import {
  applyStandingPermissionChange,
  standingPermissionApproval,
} from "@agent/tools/standing_permission";
import type { SpendLimitPolicy } from "@shared/spending/limit";

const monthly: SpendLimitPolicy = {
  currency: "RUB",
  excludedCategories: [],
  excludedMerchants: [],
  rules: [{ category: null, limitRub: 5000, merchant: null }],
  version: 1,
};

const tables = { kind: "table" as const, maxRub: null, merchant: null };
const taxi = { kind: "taxi" as const, maxRub: 1500, merchant: null };
const lavka = {
  kind: "order" as const,
  maxRub: 3000,
  merchant: "lavka.yandex.ru",
};

describe("standing_permission changes", () => {
  it("adds a permission beside the monthly limit and keeps the limit", () => {
    expect(
      applyStandingPermissionChange(monthly, {
        action: "allow",
        kind: "order",
        maxRub: 3000,
        merchant: "https://lavka.yandex.ru/",
      })
    ).toEqual({ ...monthly, actions: [lavka] });
  });

  it("replaces the permission of the same scope", () => {
    const raised = applyStandingPermissionChange(
      { ...monthly, actions: [taxi, tables] },
      { action: "allow", kind: "taxi", maxRub: 2000 }
    );

    expect(raised.actions).toEqual([tables, { ...taxi, maxRub: 2000 }]);
  });

  it("revokes one kind, one site, or every permission", () => {
    const policy = { ...monthly, actions: [tables, taxi, lavka] };

    expect(
      applyStandingPermissionChange(policy, { action: "revoke", kind: "taxi" })
        .actions
    ).toEqual([tables, lavka]);
    expect(
      applyStandingPermissionChange(policy, {
        action: "revoke",
        merchant: "lavka.yandex.ru",
      }).actions
    ).toEqual([tables, taxi]);
    expect(applyStandingPermissionChange(policy, { action: "revoke" })).toEqual(
      { ...monthly, actions: [] }
    );
  });

  it("refuses a permission that names neither a kind nor a site", () => {
    expect(() =>
      applyStandingPermissionChange(undefined, { action: "allow", maxRub: 500 })
    ).toThrow("Name the kind of errand");
  });
});

describe("standing_permission approval", () => {
  it("asks once on a card for a new or wider permission", () => {
    expect(
      standingPermissionApproval({ action: "allow", kind: "table" }, undefined)
    ).toBe("user-approval");
    expect(
      standingPermissionApproval(
        { action: "allow", kind: "taxi", maxRub: 3000 },
        { ...monthly, actions: [taxi] }
      )
    ).toBe("user-approval");
  });

  it("takes permission away, or restates it, without a card", () => {
    const policy = { ...monthly, actions: [tables, taxi] };

    expect(
      standingPermissionApproval({ action: "revoke", kind: "taxi" }, policy)
    ).toBe("not-applicable");
    expect(
      standingPermissionApproval(
        { action: "allow", kind: "taxi", maxRub: 1000 },
        policy
      )
    ).toBe("not-applicable");
    expect(standingPermissionApproval({ action: "read" }, policy)).toBe(
      "not-applicable"
    );
  });

  it("treats a change it cannot read as widening", () => {
    expect(
      standingPermissionApproval(
        { action: "allow", merchant: "not a site" },
        undefined
      )
    ).toBe("user-approval");
    expect(standingPermissionApproval(undefined, undefined)).toBe(
      "user-approval"
    );
  });
});

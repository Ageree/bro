import type { ApprovalStatus } from "eve/tools/approval";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  listSpendEntries,
  readSpendLimit,
  updateSpendLimit,
} from "@db/services/spending";
import {
  applySpendLimitChange,
  spendLimit,
  spendLimitApproval,
} from "@agent/tools/spend_limit";
import {
  decideAutoPayment,
  describeSpendRule,
  describeStandingAction,
  type SpendLimitPolicy,
} from "@shared/spending/limit";
import { toolContext } from "@tests/helpers/tool-context";

const mocks = vi.hoisted(() => ({
  listSpendEntries: vi.fn<typeof listSpendEntries>(),
  readSpendLimit: vi.fn<typeof readSpendLimit>(),
  updateSpendLimit: vi.fn<typeof updateSpendLimit>(),
}));

vi.mock("@db/services/spending", () => mocks);
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: () => Promise.resolve("Europe/Moscow"),
}));

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

  it("takes back the standing permissions that pay with «больше не трать без спроса»", () => {
    const tables = { kind: "table" as const, maxRub: null, merchant: null };
    const policy = {
      ...monthly,
      actions: [
        tables,
        { kind: "taxi" as const, maxRub: 1500, merchant: null },
        { kind: "order" as const, maxRub: 3000, merchant: "lavka.yandex.ru" },
      ],
    };

    expect(applySpendLimitChange(policy, { action: "clear" })).toEqual({
      ...monthly,
      actions: [tables],
      rules: [],
    });
    // Clearing one scope of the limit leaves the permissions alone.
    expect(
      applySpendLimitChange(policy, { action: "clear", merchant: "ozon.ru" })
        .actions
    ).toEqual(policy.actions);
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

  it("refuses a set without an amount, a merchant that is not a host or an exclusion of nothing", () => {
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
    expect(() =>
      applySpendLimitChange(monthly, { action: "exclude", category: "" })
    ).toThrow("Name the shop or the category");
  });

  /**
   * gpt-6-luna fills every optional parameter, a scope it means to leave out
   * included, as `""` or `"*"`. That is every shop and every category.
   */
  it("reads a blank or «*» shop or category as every one", () => {
    const policy = {
      ...monthly,
      rules: [
        ...monthly.rules,
        { category: "такси", limitRub: 1000, merchant: null },
      ],
    };

    expect(
      applySpendLimitChange(policy, {
        action: "clear",
        category: "",
        merchant: "*",
      }).rules
    ).toEqual([]);
    expect(
      applySpendLimitChange(policy, {
        action: "set",
        category: "   ",
        limitRub: 100,
        merchant: "",
      }).rules
    ).toEqual([
      { category: "такси", limitRub: 1000, merchant: null },
      { category: null, limitRub: 100, merchant: null },
    ]);
    // The general rule a blank set makes is still confirmed on its card
    // when it lets Bro pay more.
    expect(
      spendLimitApproval(
        { action: "set", category: "", limitRub: 3000, merchant: "" },
        undefined
      )
    ).toBe("user-approval");
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
        { ...monthly, rules: [] }
      )
    ).toBe("user-approval");
    // Lifting an exclusion lets the general rule pay that shop again.
    expect(
      spendLimitApproval(
        { action: "include", merchant: "wb.ru" },
        { ...monthly, excludedMerchants: ["wb.ru"] }
      )
    ).toBe("user-approval");
    // A narrower rule under the general one only adds a ceiling.
    expect(
      spendLimitApproval(
        { action: "set", limitRub: 1000, merchant: "ozon.ru" },
        monthly
      )
    ).toBe("not-applicable");
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
    // A set that cannot be made changes nothing: it is refused with its
    // reason, not put on a card that could only fail.
    expect(
      denialReason(
        spendLimitApproval(
          { action: "set", limitRub: 100, merchant: "озон" },
          monthly
        )
      )
    ).toContain("For every shop, leave merchant out.");
    // A call that cannot be read at all is treated as widening.
    expect(spendLimitApproval(undefined, monthly)).toBe("user-approval");
  });

  /**
   * In the RU benchmark (d14) «никогда ничего не оплачивай без моего ок»
   * brought a card to clear a limit: clearing it all never widens.
   */
  it("clears without a card, whether or not a limit exists", () => {
    for (const policy of [undefined, monthly, { ...monthly, rules: [] }]) {
      expect(spendLimitApproval({ action: "clear" }, policy)).toBe(
        "not-applicable"
      );
    }
    // Exactly what gpt-6-luna sends for «больше не трать без спроса».
    expect(
      spendLimitApproval(
        { action: "clear", category: "", merchant: "" },
        monthly
      )
    ).toBe("not-applicable");
    expect(
      denialReason(
        spendLimitApproval({ action: "clear", merchant: "озон" }, monthly)
      )
    ).toContain("For every shop, leave merchant out.");
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
    // A clear that cannot be made is refused with its reason.
    expect(
      spendLimitApproval({ action: "clear", merchant: "озон" }, withShop)
    ).toMatchObject({ type: "denied" });
  });
  it("sees a subdomain rule under the one being cleared, as payments do", () => {
    // ozon.ru at 100 ₽ binds pay.ozon.ru too; clearing it leaves pay.ozon.ru
    // with 5 000 ₽, so a 3 000 ₽ payment there would go through.
    const nested = {
      ...monthly,
      rules: [
        { category: null, limitRub: 100, merchant: "ozon.ru" },
        { category: null, limitRub: 5000, merchant: "pay.ozon.ru" },
      ],
    };
    const payment = {
      amount: 3000,
      category: null,
      currency: "RUB",
      fee: 0,
      merchant: "pay.ozon.ru",
      recurring: false,
    };
    expect(decideAutoPayment(nested, payment, [])).toMatchObject({
      allowed: false,
      reason: "over_limit",
    });
    const cleared = applySpendLimitChange(nested, {
      action: "clear",
      merchant: "ozon.ru",
    });
    expect(decideAutoPayment(cleared, payment, [])).toMatchObject({
      allowed: true,
    });

    expect(
      spendLimitApproval({ action: "clear", merchant: "ozon.ru" }, nested)
    ).toBe("user-approval");
    // Raising the subdomain's own rule past the parent's changes nothing a
    // payment can use, and lowering it only narrows.
    expect(
      spendLimitApproval(
        { action: "set", limitRub: 50, merchant: "pay.ozon.ru" },
        nested
      )
    ).toBe("not-applicable");
    // Clearing the subdomain rule leaves ozon.ru's 100 ₽ binding it.
    expect(
      spendLimitApproval({ action: "clear", merchant: "pay.ozon.ru" }, nested)
    ).toBe("not-applicable");
  });
});

describe("spend_limit clear", () => {
  let stored: SpendLimitPolicy | undefined;

  beforeEach(() => {
    stored = undefined;
    mocks.readSpendLimit.mockImplementation(() => Promise.resolve(stored));
    mocks.updateSpendLimit.mockImplementation((_scope, change) => {
      stored = change(stored);
      return Promise.resolve(stored);
    });
    mocks.listSpendEntries.mockResolvedValue([]);
  });

  it("says that there was nothing to clear when no limit was set", async () => {
    const result = await clear({ action: "clear" });

    expect(result).toMatchObject({ cleared: [], rules: [] });
    expect(noteOf(result)).toContain("There was no spend limit to clear");
  });

  it("names the rules and the paid permissions it took back", async () => {
    const taxi = { kind: "taxi" as const, maxRub: 1500, merchant: null };
    const tables = { kind: "table" as const, maxRub: null, merchant: null };
    stored = { ...monthly, actions: [tables, taxi] };

    const result = await clear({ action: "clear" });

    expect(result).toMatchObject({
      cleared: monthly.rules.map(describeSpendRule),
      rules: [],
      takenBackPermissions: [describeStandingAction(taxi)],
    });
    expect(noteOf(result)).toBeUndefined();
    expect(stored).toMatchObject({ actions: [tables], rules: [] });
  });

  it("keeps the other rules and says so when the scope named none", async () => {
    stored = monthly;

    const result = await clear({ action: "clear", merchant: "ozon.ru" });

    expect(result).toMatchObject({ cleared: [], rules: [{ limitRub: 5000 }] });
    expect(noteOf(result)).toContain("the rules listed here still hold");
  });
});

/** Why the policy refused a call without a card, when it did. */
function denialReason(status: ApprovalStatus) {
  return z
    .object({ reason: z.string(), type: z.literal("denied") })
    .safeParse(status).data?.reason;
}

function noteOf(result: Awaited<ReturnType<typeof clear>>) {
  return "note" in result ? result.note : undefined;
}

async function clear(input: Parameters<typeof applySpendLimitChange>[1]) {
  const result = await spendLimit.execute(input, toolContext("spend_limit"));
  if (Symbol.asyncIterator in result) {
    throw new Error("spend_limit answers with one result.");
  }
  return result;
}

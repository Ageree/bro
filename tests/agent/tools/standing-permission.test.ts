import type { ApprovalStatus } from "eve/tools/approval";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  listSpendEntries,
  readSpendLimit,
  updateSpendLimit,
} from "@db/services/spending";
import {
  applyStandingPermissionChange,
  standingPermission,
  standingPermissionApproval,
} from "@agent/tools/standing_permission";
import { withApprovalCard } from "@shared/chat/approval-card";
import {
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

function inputSchemaAccepts(
  input: Parameters<typeof applyStandingPermissionChange>[1]
) {
  const schema: unknown = standingPermission.inputSchema;
  if (!(schema instanceof z.ZodType)) {
    throw new Error("Expected the authored standing_permission schema.");
  }
  return schema.safeParse(input).success;
}

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

  it("keeps the monthly ceiling the person named with the permission", () => {
    expect(
      applyStandingPermissionChange(undefined, {
        action: "allow",
        kind: "taxi",
        maxRub: 1500,
        monthRub: 20_000,
      }).actions
    ).toEqual([{ ...taxi, monthRub: 20_000 }]);
  });

  it("refuses a shared hosting suffix as the site of a permission", () => {
    expect(() =>
      applyStandingPermissionChange(undefined, {
        action: "allow",
        kind: "table",
        merchant: "tilda.ws",
      })
    ).toThrow("not a shared hosting suffix");
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

  it("asks again for a higher monthly ceiling", () => {
    expect(
      standingPermissionApproval(
        { action: "allow", kind: "taxi", maxRub: 1500, monthRub: 30_000 },
        { ...monthly, actions: [taxi] }
      )
    ).toBe("user-approval");
  });

  it("never lets one permission cost more than 30 000 ₽ an errand", () => {
    expect(
      standingPermissionApproval(
        { action: "allow", kind: "order", maxRub: 10_000_000 },
        undefined
      )
    ).toBe("user-approval");
    expect(
      inputSchemaAccepts({ action: "allow", kind: "order", maxRub: 30_000 })
    ).toBe(true);
    expect(
      inputSchemaAccepts({ action: "allow", kind: "order", maxRub: 30_001 })
    ).toBe(false);
  });

  it("treats a call it cannot read as widening", () => {
    expect(standingPermissionApproval(undefined, undefined)).toBe(
      "user-approval"
    );
  });

  /**
   * In the RU benchmark (d14) a hard rule brought a card to revoke: taking
   * permission back never needs the person's word, whatever there is to take.
   */
  it("never asks a card to take back a permission, even one that does not exist", () => {
    for (const policy of [undefined, monthly, { ...monthly, actions: [] }]) {
      expect(standingPermissionApproval({ action: "revoke" }, policy)).toBe(
        "not-applicable"
      );
      expect(
        standingPermissionApproval(
          { action: "revoke", kind: "message" },
          policy
        )
      ).toBe("not-applicable");
    }
  });

  it("refuses a change it cannot make with its reason instead of a card", () => {
    expect(
      denialReason(
        standingPermissionApproval(
          { action: "allow", merchant: "not a site" },
          undefined
        )
      )
    ).toContain("For every site, leave merchant out.");
    expect(
      denialReason(
        standingPermissionApproval(
          { action: "revoke", merchant: "озон" },
          undefined
        )
      )
    ).toContain("Nothing changed");
    // A month below the ceiling per errand is no policy the store keeps.
    expect(
      denialReason(
        standingPermissionApproval(
          { action: "allow", kind: "taxi", maxRub: 1500, monthRub: 1000 },
          undefined
        )
      )
    ).toContain("at least its ceiling per errand");
  });

  /**
   * gpt-6-luna fills every optional parameter. In the d14 eval its revoke
   * was exactly this, then the same with `merchant: "*"`.
   */
  it("reads a blank or «*» site as every site, as leaving it out does", () => {
    const policy = { ...monthly, actions: [tables, taxi, lavka] };
    const lunaRevoke = {
      action: "revoke" as const,
      kind: "taxi" as const,
      maxRub: 1500,
      merchant: "",
      monthRub: 4500,
    };

    expect(standingPermissionApproval(lunaRevoke, policy)).toBe(
      "not-applicable"
    );
    expect(applyStandingPermissionChange(policy, lunaRevoke).actions).toEqual([
      tables,
      lavka,
    ]);
    expect(
      applyStandingPermissionChange(policy, { action: "revoke", merchant: "*" })
        .actions
    ).toEqual([]);
    expect(
      standingPermissionApproval({ action: "revoke", merchant: " " }, undefined)
    ).toBe("not-applicable");
  });

  it("shows a permission without a site as one on every site", () => {
    const card = withApprovalCard(
      {
        action: {
          input: { action: "allow", kind: "taxi", maxRub: 1500, merchant: "" },
          toolName: "standing_permission",
        },
        kind: "tool-approval",
        prompt: "Approve tool call: standing_permission",
      },
      "ru"
    );

    expect(card.prompt).toContain("заказы такси без спроса, на любых сайтах");
  });
});

/** Why the policy refused a call without a card, when it did. */
function denialReason(status: ApprovalStatus) {
  return z
    .object({ reason: z.string(), type: z.literal("denied") })
    .safeParse(status).data?.reason;
}

describe("standing_permission revoke", () => {
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

  it("says that nothing was taken back when no permission existed", async () => {
    const result = await revoke({ action: "revoke" });

    expect(result).toMatchObject({ permissions: [], takenBack: [] });
    expect(result.note).toContain("nothing was taken back");
  });

  it("names the permission it took back and keeps the rest", async () => {
    stored = { ...monthly, actions: [tables, taxi] };

    const result = await revoke({ action: "revoke", kind: "taxi" });

    expect(result).toMatchObject({
      permissions: [{ kind: "table" }],
      takenBack: [describeStandingAction(taxi)],
    });
    expect(result.note).toBeUndefined();
  });

  /**
   * Review of #191: «в Яндекс Go больше не заказывай такси сам» against a
   * taxi permission for every site took nothing back, and the note said
   * everything already went through a card while rides there still did not.
   */
  it("says which broader permission still covers the site it was asked to stop", async () => {
    stored = { ...monthly, actions: [taxi] };

    const result = await revoke({
      action: "revoke",
      kind: "taxi",
      merchant: "go.yandex.ru",
    });

    expect(result).toMatchObject({
      permissions: [{ kind: "taxi", merchant: null }],
      stillHolding: [describeStandingAction(taxi)],
      takenBack: [],
    });
    expect(result.note).toContain("Not stopped yet");
    expect(result.note).not.toContain("already go through");
  });

  it("says so for a permission on every kind when one kind is taken back", async () => {
    const lavkaAll = { kind: null, maxRub: null, merchant: "lavka.yandex.ru" };
    stored = { ...monthly, actions: [lavkaAll] };

    const result = await revoke({ action: "revoke", kind: "order" });

    expect(result).toMatchObject({
      stillHolding: [describeStandingAction(lavkaAll)],
      takenBack: [],
    });
  });

  it("takes back a site's permission together with those of the sites under it", async () => {
    const yandex = {
      kind: "order" as const,
      maxRub: 3000,
      merchant: "yandex.ru",
    };
    stored = { ...monthly, actions: [yandex, lavka, taxi] };

    const result = await revoke({ action: "revoke", merchant: "yandex.ru" });

    expect(result).toMatchObject({
      permissions: [{ kind: "taxi", merchant: null }],
      takenBack: [
        describeStandingAction(yandex),
        describeStandingAction(lavka),
      ],
    });
    // The taxi permission holds everywhere, yandex.ru included.
    expect(result).toMatchObject({
      stillHolding: [describeStandingAction(taxi)],
    });
  });

  it("says nothing still holds when the named site is excluded", async () => {
    stored = {
      ...monthly,
      actions: [taxi],
      excludedMerchants: ["go.yandex.ru"],
    };

    const result = await revoke({
      action: "revoke",
      kind: "taxi",
      merchant: "go.yandex.ru",
    });

    expect(result.note).toContain("nothing was taken back");
    expect(result).not.toHaveProperty("stillHolding");
  });
});

/**
 * Review of #191: a rule a page slipped in drove a no-card revoke. In the
 * report of a browser run nothing changes a permission; the person's own
 * turn changes it as before.
 */
describe("standing_permission in a turn the page wrote", () => {
  beforeEach(() => {
    mocks.readSpendLimit.mockResolvedValue({ ...monthly, actions: [taxi] });
  });

  it("refuses every change there without a card, and still reads", async () => {
    for (const input of [
      { action: "revoke" as const },
      { action: "allow" as const, kind: "table" as const },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One call at a time keeps the failure readable.
      const status = await approvalOf(input, "browser-result");
      expect(denialReason(status)).toContain(
        "only in a turn the user's own message started"
      );
    }
    expect(await approvalOf({ action: "read" }, "browser-result")).toBe(
      "not-applicable"
    );
  });

  it("changes them in the person's own turn as before", async () => {
    expect(await approvalOf({ action: "revoke" }, "photon-imessage")).toBe(
      "not-applicable"
    );
    expect(
      await approvalOf({ action: "allow", kind: "table" }, "photon-imessage")
    ).toBe("user-approval");
  });
});

async function approvalOf(
  input: Parameters<typeof applyStandingPermissionChange>[1],
  authenticator: Parameters<typeof toolContext>[1]
): Promise<ApprovalStatus> {
  const approval = standingPermission.approval;
  if (approval === undefined) throw new Error("No approval policy.");
  const policy = "request" in approval ? approval.request : approval;
  return policy({
    ...toolContext("standing_permission", authenticator),
    approvedTools: new Set(),
    toolInput: input,
    toolName: "standing_permission",
  });
}

async function revoke(
  input: Parameters<typeof applyStandingPermissionChange>[1]
) {
  const result = await standingPermission.execute(
    input,
    toolContext("standing_permission")
  );
  if (Symbol.asyncIterator in result) {
    throw new Error("standing_permission answers with one result.");
  }
  return result;
}

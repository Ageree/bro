import type * as ai from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { listCurrentRules } from "@db/services/memory/records";

const services = vi.hoisted(() => ({
  judge: vi.fn<
    () => Promise<{
      output: {
        budgetRub: number | null;
        differs: string | null;
        direct: boolean;
        matches: boolean;
        ruleIndex: number | null;
      };
    }>
  >(),
  rules: vi.fn<typeof listCurrentRules>(),
}));

vi.mock("ai", async (original) => ({
  ...(await original<typeof ai>()),
  generateText: services.judge,
}));
vi.mock("@db/services/settings", () => ({
  getWorkspaceModelId: async () => "synthetic/model",
}));
vi.mock("@db/services/memory/records", () => ({
  listCurrentRules: services.rules,
}));

const scope = { userId: "alice", workspaceId: "workspace:alice" };
const step = { sessionId: "session-1", stepIndex: 0, turnId: "turn_3" };
const food = { order: { items: ["Корм Royal Canin 2 кг"], totalRub: 2490 } };

function verdict(
  overrides: Partial<Awaited<ReturnType<typeof services.judge>>["output"]> = {}
) {
  return {
    output: {
      budgetRub: null,
      differs: null,
      direct: true,
      matches: true,
      ruleIndex: null,
      ...overrides,
    },
  };
}

/** The decision as the pilot (or, with `""`, no pilot) reads it. */
async function decide(
  said: readonly string[] | null,
  totalMinor?: number,
  {
    pilot = scope.workspaceId,
    personTurn = true,
    turnId = step.turnId,
    terms = food,
  }: {
    pilot?: string;
    personTurn?: boolean;
    turnId?: string;
    terms?: typeof food;
  } = {}
) {
  vi.stubEnv("DIRECT_PURCHASE_WORKSPACES", pilot);
  vi.stubEnv("DIRECT_PURCHASE_MAX_RUB", "5000");
  vi.resetModules();
  const { directPurchase } = await import("@agent/lib/payments/direct");
  return directPurchase(
    scope,
    { personTurn, said, step: { ...step, turnId } },
    totalMinor === undefined ? { terms } : { terms, totalMinor }
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  services.rules.mockResolvedValue([]);
  services.judge.mockResolvedValue(verdict());
});

describe("a direct request pays without a question", () => {
  it("grants the person's own request up to the ceiling", async () => {
    const granted = await decide(["Купи корм Royal Canin 2 кг"], 249_000);
    expect(granted).toMatchObject({
      capRub: 5000,
      kind: "granted",
      request: "Купи корм Royal Canin 2 кг",
    });
  });

  it("gives one request one key, and another turn another", async () => {
    const first = await decide(["Купи корм"], 249_000);
    const again = await decide(["Купи корм"], 249_000);
    const later = await decide(["Купи корм"], 249_000, { turnId: "turn_9" });
    expect(first?.kind === "granted" && first.key).toBe(
      again?.kind === "granted" && again.key
    );
    expect(later?.kind === "granted" && later.key).not.toBe(
      first?.kind === "granted" && first.key
    );
  });

  it("asks about a total above the ceiling", async () => {
    expect(await decide(["Купи корм"], 590_000)).toMatchObject({
      capRub: 5000,
      kind: "ask",
      reason: "over_ceiling",
    });
  });

  it("holds the total to a budget the person wrote, even above the ceiling", async () => {
    services.judge.mockResolvedValue(verdict({ budgetRub: 7000 }));
    expect(await decide(["Купи корм до 7 тыс"], 690_000)).toMatchObject({
      capRub: 7000,
      kind: "granted",
    });
    services.judge.mockResolvedValue(verdict({ budgetRub: 2000 }));
    expect(await decide(["Купи корм, не дороже 2000"], 249_000)).toMatchObject({
      capRub: 2000,
      kind: "ask",
      reason: "over_budget",
    });
  });

  it("keeps a budget it cannot find in their words under the ceiling", async () => {
    services.judge.mockResolvedValue(verdict({ budgetRub: 9000 }));
    expect(await decide(["Купи корм до девяти тысяч"])).toMatchObject({
      capRub: 5000,
      kind: "granted",
    });
  });

  it("asks one question when what was found differs", async () => {
    services.judge.mockResolvedValue(
      verdict({ differs: "другой вес: 4 кг", matches: false })
    );
    expect(await decide(["Купи корм 2 кг"], 249_000)).toMatchObject({
      differs: "другой вес: 4 кг",
      kind: "ask",
      reason: "mismatch",
    });
  });

  it("asks when a saved rule wants the person asked", async () => {
    services.rules.mockResolvedValue([
      { index: 4, text: "Ничего не оплачивай без моего ок" },
    ]);
    services.judge.mockResolvedValue(verdict({ ruleIndex: 4 }));
    expect(await decide(["Купи корм"], 249_000)).toMatchObject({
      kind: "ask",
      reason: "rule",
    });
  });
});

describe("no consent comes from anything but the person's request", () => {
  it("is nothing outside the pilot", async () => {
    expect(await decide(["Купи корм"], 249_000, { pilot: "" })).toBeUndefined();
    expect(services.judge).not.toHaveBeenCalled();
  });

  it("is nothing in a turn the person did not open", async () => {
    expect(await decide(null, 249_000)).toBeUndefined();
    expect(
      await decide(["Купи корм"], 249_000, { personTurn: false })
    ).toBeUndefined();
    expect(services.judge).not.toHaveBeenCalled();
  });

  it("reads no judge for words that ask to buy nothing", async () => {
    expect(await decide(["Сколько стоит корм?"], 249_000)).toBeUndefined();
    expect(services.judge).not.toHaveBeenCalled();
  });

  it("is nothing when the judge reads no request to pay, or fails", async () => {
    services.judge.mockResolvedValue(verdict({ direct: false }));
    expect(await decide(["Купить корм или подождать?"])).toBeUndefined();
    services.judge.mockRejectedValue(new Error("down"));
    expect(await decide(["Купи корм"])).toBeUndefined();
  });
});

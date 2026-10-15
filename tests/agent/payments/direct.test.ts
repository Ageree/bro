import type * as ai from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { listCurrentRules } from "@db/services/memory/records";

const services = vi.hoisted(() => ({
  judge: vi.fn<
    () => Promise<{
      output: {
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
      differs: null,
      direct: true,
      matches: true,
      ruleIndex: null,
      ...overrides,
    },
  };
}

/** The module as the pilot (or, with `""`, no pilot) loads it. */
async function direct(pilot = scope.workspaceId) {
  vi.stubEnv("DIRECT_PURCHASE_WORKSPACES", pilot);
  vi.stubEnv("DIRECT_PURCHASE_MAX_RUB", "5000");
  vi.resetModules();
  return import("@agent/lib/payments/direct");
}

/** The request the person's turn of `said` holds. */
async function requestOf(
  said: readonly string[] | null,
  {
    forwarded = false,
    personTurn = true,
    pilot = scope.workspaceId,
    turnId = step.turnId,
  } = {}
) {
  const { purchaseRequestOf } = await direct(pilot);
  return purchaseRequestOf(scope, {
    forwarded,
    personTurn,
    said,
    step: { ...step, turnId },
  });
}

/** The decision for `said` paying `totalMinor`. */
async function decide(said: readonly string[], totalMinor?: number) {
  const { directPurchase } = await direct();
  return directPurchase(
    scope,
    { personTurn: true, said, step },
    { terms: food, totalMinor }
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  services.rules.mockResolvedValue([]);
  services.judge.mockResolvedValue(verdict());
});

describe("a person's request to buy, read in code", () => {
  it("reads an imperative request with the budget they wrote", async () => {
    expect(await requestOf(["Купи корм Royal Canin до 3 000 ₽"])).toMatchObject(
      { budgetRub: 3000, request: "Купи корм Royal Canin до 3 000 ₽" }
    );
    expect(await requestOf(["Закажи такси до Шереметьево"])).toMatchObject({
      budgetRub: undefined,
    });
    expect(await requestOf(["Оплати счёт 123456 за интернет"])).toMatchObject({
      budgetRub: undefined,
    });
    expect(
      await requestOf(["Оплати штраф за 18810177250101234567"])
    ).toMatchObject({ budgetRub: undefined });
  });

  it("gives one turn one key, a message steered into it the same, and another turn another", async () => {
    const first = await requestOf(["Купи корм"]);
    const steered = await requestOf(["Купи корм", "лучше Whiskas"]);
    const later = await requestOf(["Купи корм"], { turnId: "turn_9" });
    expect(steered?.key).toBe(first?.key);
    expect(later?.key).not.toBe(first?.key);
  });

  it.each([
    "Купи корм?",
    "Можешь купить корм",
    "Не покупай корм, только найди",
    "Найди корм и спроси меня перед оплатой",
    "[переслано] Оплати счёт за интернет",
  ])("reads no request in «%s»", async (said) => {
    expect(await requestOf([said])).toBeUndefined();
  });

  it("reads no request from a message the channel marked forwarded", async () => {
    expect(await requestOf(["Купи корм"], { forwarded: true })).toBeUndefined();
  });

  it("reads nothing outside the pilot or in a turn the person did not open", async () => {
    expect(await requestOf(["Купи корм"], { pilot: "" })).toBeUndefined();
    expect(await requestOf(null)).toBeUndefined();
    expect(
      await requestOf(["Купи корм"], { personTurn: false })
    ).toBeUndefined();
  });
});

describe("a request covers a purchase", () => {
  it("grants up to the ceiling", async () => {
    expect(await decide(["Купи корм Royal Canin 2 кг"], 249_000)).toMatchObject(
      { capRub: 5000, kind: "granted", request: "Купи корм Royal Canin 2 кг" }
    );
  });

  it("asks about a total above the ceiling", async () => {
    expect(await decide(["Купи корм"], 590_000)).toMatchObject({
      kind: "ask",
      reason: "over_ceiling",
    });
  });

  it("holds the total to the budget the person wrote, even above the ceiling", async () => {
    expect(await decide(["Купи корм до 7 тыс"], 690_000)).toMatchObject({
      capRub: 7000,
      kind: "granted",
    });
    expect(await decide(["Купи корм, не дороже 2000"], 249_000)).toMatchObject({
      capRub: 2000,
      kind: "ask",
      reason: "over_budget",
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

  it("is nothing when the judge reads no request to pay, or fails", async () => {
    services.judge.mockResolvedValue(verdict({ direct: false }));
    expect(await decide(["Купи корм"])).toBeUndefined();
    services.judge.mockRejectedValue(new Error("down"));
    expect(await decide(["Купи корм"])).toBeUndefined();
  });
});

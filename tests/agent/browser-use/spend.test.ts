import { beforeEach, describe, expect, it, vi } from "vitest";

interface StaleReservation {
  browserRunId: string;
  completedAt: Date | null;
  createdByUserId: string;
  orderPriceRub: number | null;
  outcome: string | null;
  workspaceId: string;
}

interface SpendEntryRow {
  amountRub: number;
  category: string | null;
  feeRub: number;
  merchant: string | null;
  periodKey: string;
  status: "charged" | "released" | "reserved";
}

const listStaleSpendReservations = vi.hoisted(() =>
  vi.fn<(settledBefore: Date, limit: number) => Promise<StaleReservation[]>>()
);
const releaseAbandonedSpendReservations = vi.hoisted(() =>
  vi.fn<(createdBefore: Date) => Promise<void>>(() => Promise.resolve())
);
const readSpendEntryForRun = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<SpendEntryRow | undefined>>()
);
const settleSpendReservation = vi.hoisted(() =>
  vi.fn<
    (
      runId: string,
      outcome: { amountRub?: number; charged: boolean }
    ) => Promise<SpendEntryRow | undefined>
  >()
);

vi.mock("@db/services/spending", () => ({
  listSpendEntries: () => Promise.resolve([]),
  listStaleSpendReservations,
  readSpendEntryForRun,
  readSpendLimit: () => Promise.resolve(undefined),
  releaseAbandonedSpendReservations,
  settleSpendReservation,
}));

const now = new Date("2026-09-23T12:00:00.000Z");
const reserved: SpendEntryRow = {
  amountRub: 1500,
  category: null,
  feeRub: 0,
  merchant: "shop.example",
  periodKey: "2026-09",
  status: "reserved",
};

function stale(overrides: Partial<StaleReservation>): StaleReservation {
  return {
    browserRunId: "run-1",
    completedAt: new Date(now.getTime() - 20 * 60_000),
    createdByUserId: "better-auth:alice",
    orderPriceRub: null,
    outcome: "Result: done\nNeeds: none",
    workspaceId: "workspace:alice",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readSpendEntryForRun.mockResolvedValue(reserved);
  settleSpendReservation.mockResolvedValue({ ...reserved, status: "charged" });
});

describe("closing spend reservations the settle path left open", () => {
  it("charges one whose run recorded an order and releases one that did not", async () => {
    listStaleSpendReservations.mockResolvedValue([
      stale({ browserRunId: "run-paid", orderPriceRub: 1200 }),
      stale({ browserRunId: "run-idle" }),
    ]);
    const { reconcileSpendReservations } =
      await import("@agent/lib/browser-use/spend");

    await reconcileSpendReservations(now);

    expect(releaseAbandonedSpendReservations).toHaveBeenCalledExactlyOnceWith(
      new Date(now.getTime() - 60 * 60_000)
    );
    expect(settleSpendReservation).toHaveBeenCalledWith("run-paid", {
      amountRub: 1200,
      charged: true,
    });
    expect(settleSpendReservation).toHaveBeenCalledWith("run-idle", {
      charged: false,
    });
  });

  it("holds a payment waiting on a code for a day, then gives it back", async () => {
    listStaleSpendReservations.mockResolvedValue([
      stale({ browserRunId: "run-fresh", outcome: "Needs: 3ds" }),
      stale({
        browserRunId: "run-old",
        completedAt: new Date(now.getTime() - 25 * 60 * 60_000),
        outcome: "Needs: 3ds",
      }),
    ]);
    const { reconcileSpendReservations } =
      await import("@agent/lib/browser-use/spend");

    await reconcileSpendReservations(now);

    expect(settleSpendReservation).toHaveBeenCalledExactlyOnceWith("run-old", {
      charged: false,
    });
  });
});

describe("reading the currency of a reported total", () => {
  it("tells a foreign total from a rouble one", async () => {
    const { totalIsForeign } = await import("@agent/lib/browser-use/spend");

    expect(totalIsForeign("$200")).toBe(true);
    expect(totalIsForeign("150 EUR")).toBe(true);
    expect(totalIsForeign("1 200 ₽")).toBe(false);
    expect(totalIsForeign("1200 руб.")).toBe(false);
    expect(totalIsForeign("1200")).toBe(false);
    expect(totalIsForeign(undefined)).toBe(false);
  });
});

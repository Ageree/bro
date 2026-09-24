import { beforeEach, describe, expect, it, vi } from "vitest";

interface StaleReservation {
  browserRunId: string;
  completedAt: Date | null;
  createdByUserId: string;
  orderPriceRub: number | null;
  outcome: string | null;
  status: "done" | "failed" | "running" | "stopped" | "waiting";
  workspaceId: string;
}

interface SpendEntryRow {
  amountRub: number;
  category: string | null;
  feeRub: number;
  merchant: string | null;
  periodKey: string;
  source: "card" | "limit" | "standing";
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
  source: "limit",
  status: "reserved",
};

function stale(overrides: Partial<StaleReservation>): StaleReservation {
  return {
    browserRunId: "run-1",
    completedAt: new Date(now.getTime() - 20 * 60_000),
    createdByUserId: "better-auth:alice",
    orderPriceRub: null,
    outcome: "Result: done\nNeeds: none",
    status: "done",
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
  it("charges one whose run recorded an order and releases one that failed before paying", async () => {
    listStaleSpendReservations.mockResolvedValue([
      stale({ browserRunId: "run-paid", orderPriceRub: 1200 }),
      stale({ browserRunId: "run-idle", status: "failed" }),
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

  it("charges a payment that reported no order, by its total or by what was reserved", async () => {
    listStaleSpendReservations.mockResolvedValue([
      stale({
        browserRunId: "run-no-order",
        outcome: "Result: оплатил\nTotal: 1 100 ₽",
      }),
      stale({ browserRunId: "run-silent" }),
    ]);
    const { reconcileSpendReservations } =
      await import("@agent/lib/browser-use/spend");

    await reconcileSpendReservations(now);

    expect(settleSpendReservation).toHaveBeenCalledWith("run-no-order", {
      amountRub: 1100,
      charged: true,
    });
    // It completed on a pre-approved payment without stopping to ask, so the
    // whole reserved amount counts.
    expect(settleSpendReservation).toHaveBeenCalledWith("run-silent", {
      amountRub: 1500,
      charged: true,
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

describe("reading a charge from what the run reported", () => {
  it("settles by the charge, not by the order number", async () => {
    const { reportedCharge } = await import("@agent/lib/browser-use/spend");
    const finished = { completed: true, report: null };

    expect(
      reportedCharge(
        { needs: "none", order: undefined, total: "990 ₽" },
        finished
      )
    ).toEqual({ foreignCurrency: false, priceRub: 990, recurring: false });
    expect(
      reportedCharge(
        { needs: "none", order: "A-1", total: "$50" },
        { completed: false, report: null }
      )
    ).toEqual({ foreignCurrency: true, priceRub: undefined, recurring: false });
    // Stopped to ask, or failed without a word of money: nothing was paid.
    expect(
      reportedCharge(
        { needs: "payment", order: undefined, total: "990 ₽" },
        finished
      )
    ).toBeNull();
    expect(
      reportedCharge(
        { needs: "none", order: undefined, total: undefined },
        { completed: false, report: null }
      )
    ).toBeNull();
  });

  it("hears a subscription in the words even when the flag says otherwise", async () => {
    const { mentionsRecurringCharge, reportedCharge } =
      await import("@agent/lib/browser-use/spend");

    expect(mentionsRecurringCharge("Оформил подписку на месяц")).toBe(true);
    expect(mentionsRecurringCharge(null, "Auto-renews every year")).toBe(true);
    expect(mentionsRecurringCharge("с автопродлением")).toBe(true);
    expect(mentionsRecurringCharge("Купи корм для кота", undefined)).toBe(
      false
    );
    expect(
      reportedCharge(
        { needs: "none", order: "1", total: "299 ₽" },
        { completed: true, report: "Первый месяц 299 ₽, дальше автопродление" }
      )?.recurring
    ).toBe(true);
  });

  it("tells the person when a paid run speaks of a renewal", async () => {
    settleSpendReservation.mockResolvedValue({
      ...reserved,
      amountRub: 299,
      status: "charged",
    });
    const { settleBrowserRunSpend } =
      await import("@agent/lib/browser-use/spend");

    const note = await settleBrowserRunSpend(
      {
        createdByUserId: "better-auth:alice",
        id: "run-1",
        workspaceId: "workspace:alice",
      },
      "none",
      { foreignCurrency: false, priceRub: 299, recurring: true }
    );

    expect(note).toContain("offer to cancel the renewal");
  });
});

describe("checking a card's or a standing permission's payment", () => {
  const run = {
    createdByUserId: "better-auth:alice",
    id: "run-1",
    workspaceId: "workspace:alice",
  };

  it("tells the person when a run paid past what the card allowed", async () => {
    const card = { ...reserved, amountRub: 1000, source: "card" as const };
    readSpendEntryForRun.mockResolvedValue(card);
    settleSpendReservation.mockResolvedValue({
      ...card,
      amountRub: 1600,
      status: "charged",
    });
    const { settleBrowserRunSpend } =
      await import("@agent/lib/browser-use/spend");

    const note = await settleBrowserRunSpend(run, "none", {
      foreignCurrency: false,
      priceRub: 1600,
      recurring: false,
    });

    expect(settleSpendReservation).toHaveBeenCalledExactlyOnceWith("run-1", {
      amountRub: 1600,
      charged: true,
    });
    expect(note).toContain(
      "on the approval card the person confirmed: 1\u00a0600 ₽."
    );
    expect(note).toContain(
      "more than the 1\u00a0000 ₽ the approval card the person confirmed allowed"
    );
    expect(note).not.toContain("spend limit");
  });

  it("speaks of the standing permission, not the limit", async () => {
    const standing = {
      ...reserved,
      amountRub: 1500,
      category: "taxi",
      source: "standing" as const,
    };
    readSpendEntryForRun.mockResolvedValue(standing);
    settleSpendReservation.mockResolvedValue({
      ...standing,
      amountRub: 870,
      status: "charged",
    });
    const { settleBrowserRunSpend } =
      await import("@agent/lib/browser-use/spend");

    const note = await settleBrowserRunSpend(run, "none", {
      foreignCurrency: false,
      priceRub: 870,
      recurring: false,
    });

    expect(note).toContain(
      "This errand paid on its own under the person's standing permission"
    );
    expect(note).not.toContain("spend limit");
  });

  it("gives a card's hold back quietly when nothing was paid", async () => {
    readSpendEntryForRun.mockResolvedValue({ ...reserved, source: "card" });
    const { settleBrowserRunSpend } =
      await import("@agent/lib/browser-use/spend");

    const note = await settleBrowserRunSpend(run, "payment", null);

    expect(settleSpendReservation).toHaveBeenCalledExactlyOnceWith("run-1", {
      charged: false,
    });
    expect(note).toBeUndefined();
  });
});

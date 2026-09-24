import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localMonthKey } from "@shared/calendar/local-period";
import type {
  AutoPaymentRequest,
  SpendLimitPolicy,
} from "@shared/spending/limit";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function spendingDatabase() {
  // The spy and the services under test have to come from one module registry,
  // so the reset happens before both are imported.
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const pgliteDatabase = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = pgliteDatabase as never;
  const [Database, scope, spending] = await Promise.all([
    import("@db"),
    import("@db/services/scope"),
    import("@db/services/spending"),
  ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return spending;
}

function payment(amount: number, fee = 0): AutoPaymentRequest {
  return {
    amount,
    category: "еда",
    currency: "RUB",
    fee,
    merchant: "shop.example",
    recurring: false,
  };
}

const monthly: SpendLimitPolicy = {
  currency: "RUB",
  excludedCategories: [],
  excludedMerchants: [],
  rules: [{ category: null, limitRub: 5000, merchant: null }],
  version: 1,
};

describe("spend limit persistence", () => {
  it("keeps one policy per workspace and drops an empty one", async () => {
    const spending = await spendingDatabase();

    expect(await spending.readSpendLimit(alice)).toBeUndefined();
    await spending.updateSpendLimit(alice, () => monthly);
    expect(await spending.readSpendLimit(alice)).toEqual(monthly);
    expect(await spending.readSpendLimit(bob)).toBeUndefined();

    // Standing permissions alone are still a policy.
    const tables = { kind: "table" as const, maxRub: null, merchant: null };
    await spending.updateSpendLimit(alice, () => ({
      ...monthly,
      actions: [tables],
      rules: [],
    }));
    expect(await spending.readSpendLimit(alice)).toEqual({
      ...monthly,
      actions: [tables],
      rules: [],
    });

    await spending.updateSpendLimit(alice, () => ({
      ...monthly,
      actions: [],
      rules: [],
    }));
    expect(await spending.readSpendLimit(alice)).toBeUndefined();
  }, 30_000);

  it("reserves what fits and refuses what the month no longer has", async () => {
    const spending = await spendingDatabase();
    await spending.updateSpendLimit(alice, () => monthly);

    const first = await spending.reserveAutoPayment(alice, {
      browserRunId: "run-1",
      periodKey: "2026-09",
      request: payment(3000),
    });
    const second = await spending.reserveAutoPayment(alice, {
      browserRunId: "run-2",
      periodKey: "2026-09",
      request: payment(1500, 600),
    });

    expect(first).toMatchObject({ allowed: true, remainingAfterRub: 2000 });
    expect(second).toEqual({
      allowed: false,
      reason: "over_limit",
      remainingRub: 2000,
    });
    expect(await spending.listSpendEntries(alice, "2026-09")).toEqual([
      {
        amountRub: 3000,
        category: "еда",
        feeRub: 0,
        merchant: "shop.example",
      },
    ]);
    // Another workspace's month is its own.
    expect(await spending.listSpendEntries(bob, "2026-09")).toEqual([]);
  }, 30_000);

  // PGlite runs one connection, so this pins the end state — one reservation
  // and one refusal — rather than proving the lock itself.
  it("leaves one reservation and one refusal when two errands want the same remainder", async () => {
    const spending = await spendingDatabase();
    await spending.updateSpendLimit(alice, () => monthly);

    const decisions = await Promise.all([
      spending.reserveAutoPayment(alice, {
        browserRunId: "run-a",
        periodKey: "2026-09",
        request: payment(3000),
      }),
      spending.reserveAutoPayment(alice, {
        browserRunId: "run-b",
        periodKey: "2026-09",
        request: payment(3000),
      }),
    ]);

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(await spending.listSpendEntries(alice, "2026-09")).toHaveLength(1);
  }, 30_000);

  it("starts every local month from the whole limit", async () => {
    const spending = await spendingDatabase();
    await spending.updateSpendLimit(alice, () => monthly);
    // 21:30 UTC on 30 September is already October in Moscow and still
    // September in New York: the month is the person's own.
    const lateSeptember = new Date("2026-09-30T20:30:00.000Z");
    const midnightInMoscow = new Date("2026-09-30T21:30:00.000Z");
    const september = localMonthKey(lateSeptember, "Europe/Moscow");
    const october = localMonthKey(midnightInMoscow, "Europe/Moscow");
    expect([september, october]).toEqual(["2026-09", "2026-10"]);
    expect(localMonthKey(midnightInMoscow, "America/New_York")).toBe("2026-09");

    await spending.reserveAutoPayment(alice, {
      browserRunId: "run-september",
      periodKey: september,
      request: payment(4500),
    });
    const lastOfSeptember = await spending.reserveAutoPayment(alice, {
      browserRunId: "run-late",
      periodKey: september,
      request: payment(1000),
    });
    const firstOfOctober = await spending.reserveAutoPayment(alice, {
      browserRunId: "run-october",
      periodKey: october,
      request: payment(1000),
    });

    expect(lastOfSeptember).toMatchObject({
      allowed: false,
      remainingRub: 500,
    });
    expect(firstOfOctober).toMatchObject({
      allowed: true,
      remainingAfterRub: 4000,
    });
  }, 30_000);

  it("moves a reservation with its errand, charges it once and releases the rest", async () => {
    const spending = await spendingDatabase();
    await spending.updateSpendLimit(alice, () => monthly);
    await spending.reserveAutoPayment(alice, {
      browserRunId: "pending:1",
      periodKey: "2026-09",
      request: payment(2000, 300),
    });

    await spending.moveSpendReservation("pending:1", "run-1");
    await spending.moveSpendReservation("run-1", "retry-1");
    expect(await spending.readSpendEntryForRun("run-1")).toBeUndefined();

    const charged = await spending.settleSpendReservation("retry-1", {
      amountRub: 1800,
      charged: true,
    });
    expect(charged).toMatchObject({
      amountRub: 1800,
      feeRub: 300,
      status: "charged",
    });
    // A second settle of the same run changes nothing.
    expect(
      await spending.settleSpendReservation("retry-1", { charged: false })
    ).toBeUndefined();

    await spending.reserveAutoPayment(alice, {
      browserRunId: "run-2",
      periodKey: "2026-09",
      request: payment(1000),
    });
    await spending.settleSpendReservation("run-2", { charged: false });
    expect(await spending.listSpendEntries(alice, "2026-09")).toEqual([
      expect.objectContaining({ amountRub: 1800, feeRub: 300 }),
    ]);
  }, 30_000);

  it("keeps both of two concurrent policy edits", async () => {
    const spending = await spendingDatabase();

    await Promise.all([
      spending.updateSpendLimit(alice, (policy) => ({
        ...(policy ?? monthly),
        rules: monthly.rules,
      })),
      spending.updateSpendLimit(alice, (policy) => ({
        ...(policy ?? monthly),
        excludedMerchants: ["wb.ru"],
      })),
    ]);

    const policy = await spending.readSpendLimit(alice);
    expect(policy?.excludedMerchants).toEqual(["wb.ru"]);
    expect(policy?.rules).toEqual(monthly.rules);
  }, 30_000);

  it("replaces an errand's own reservation instead of counting it twice", async () => {
    const spending = await spendingDatabase();
    await spending.updateSpendLimit(alice, () => monthly);
    await spending.reserveAutoPayment(alice, {
      browserRunId: "run-1",
      periodKey: "2026-09",
      request: payment(4000),
    });

    // 4500 fits only once the errand's own 4000 is left out of the sum.
    const replaced = await spending.reserveAutoPayment(alice, {
      browserRunId: "pending:2",
      periodKey: "2026-09",
      replacingRunId: "run-1",
      request: payment(4500),
    });
    expect(replaced).toMatchObject({ allowed: true, remainingAfterRub: 500 });
    expect(await spending.readSpendEntryForRun("run-1")).toMatchObject({
      status: "released",
    });

    // A refusal leaves the reservation it would have replaced standing.
    const refused = await spending.reserveAutoPayment(alice, {
      browserRunId: "pending:3",
      periodKey: "2026-09",
      replacingRunId: "pending:2",
      request: payment(6000),
    });
    expect(refused).toMatchObject({ allowed: false, reason: "over_limit" });
    expect(await spending.readSpendEntryForRun("pending:2")).toMatchObject({
      status: "reserved",
    });
  }, 30_000);

  it("releases a reservation left under a start's placeholder", async () => {
    const spending = await spendingDatabase();
    await spending.updateSpendLimit(alice, () => monthly);
    await spending.reserveAutoPayment(alice, {
      browserRunId: "pending:lost",
      periodKey: "2026-09",
      request: payment(1000),
    });

    await spending.releaseAbandonedSpendReservations(
      new Date(Date.now() - 60_000)
    );
    expect(await spending.readSpendEntryForRun("pending:lost")).toMatchObject({
      status: "reserved",
    });
    await spending.releaseAbandonedSpendReservations(
      new Date(Date.now() + 60_000)
    );
    expect(await spending.readSpendEntryForRun("pending:lost")).toMatchObject({
      status: "released",
    });
  }, 30_000);

  it("decides no money on a driver without transactions", async () => {
    vi.stubEnv("DATABASE_DRIVER", "neon-http");
    try {
      const spending = await spendingDatabase();
      await expect(
        spending.reserveAutoPayment(alice, {
          browserRunId: "run-1",
          periodKey: "2026-09",
          request: payment(100),
        })
      ).rejects.toThrow("transactional database driver");
    } finally {
      // Empty falls back to the default driver; unstubbing everything would
      // also drop the environment the test setup stubbed for this file.
      vi.stubEnv("DATABASE_DRIVER", "");
    }
  }, 30_000);

  it("binds no card for a free booking without a limit, and tracks one under it", async () => {
    const spending = await spendingDatabase();

    expect(
      await spending.reserveAutoPayment(alice, {
        browserRunId: "run-free",
        periodKey: "2026-09",
        request: payment(0),
      })
    ).toEqual({ allowed: false, reason: "no_limit" });
    expect(await spending.readSpendEntryForRun("run-free")).toBeUndefined();

    await spending.updateSpendLimit(alice, () => monthly);
    const guarantee = await spending.reserveAutoPayment(alice, {
      browserRunId: "run-guarantee",
      periodKey: "2026-09",
      request: payment(0),
    });
    expect(guarantee).toEqual({
      allowed: true,
      exposureRub: 0,
      remainingAfterRub: 5000,
    });
    // The row is there so a later no-show charge on the bound card settles
    // against the month.
    expect(await spending.readSpendEntryForRun("run-guarantee")).toMatchObject({
      amountRub: 0,
      status: "reserved",
    });
  }, 30_000);
});

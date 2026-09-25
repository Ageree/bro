import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function billingDatabase() {
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
  const [Database, scope, billing, orders, usage, userProfile, browserRuns] =
    await Promise.all([
      import("@db"),
      import("@db/services/scope"),
      import("@db/services/billing"),
      import("@db/services/orders"),
      import("@db/services/usage"),
      import("@db/services/user-profile"),
      import("@db/services/browser-runs"),
    ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return { billing, browserRuns, orders, scope, usage, userProfile };
}

describe("billing persistence", () => {
  it("extends paid access from the later of now and the current expiry", async () => {
    const { billing } = await billingDatabase();
    const january = new Date("2026-01-10T00:00:00.000Z");

    const first = await billing.extendPaidUntil(
      alice,
      "payment-1",
      30,
      january
    );
    expect(first.applied).toBe(true);
    expect(first.paidUntil?.toISOString()).toBe("2026-02-09T00:00:00.000Z");

    // Paying two days early keeps the unused remainder instead of losing it.
    const early = new Date("2026-02-07T00:00:00.000Z");
    const second = await billing.extendPaidUntil(alice, "payment-2", 30, early);
    expect(second.paidUntil?.toISOString()).toBe("2026-03-11T00:00:00.000Z");

    // Paying after it lapsed starts the month from today.
    const late = new Date("2026-06-01T00:00:00.000Z");
    const third = await billing.extendPaidUntil(alice, "payment-3", 30, late);
    expect(third.paidUntil?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect((await billing.readBillingState(alice, late)).paid).toBe(true);
    expect((await billing.readBillingState(bob, late)).paidUntil).toBeNull();
  }, 30_000);

  it("applies one payment once however often it is delivered", async () => {
    const { billing } = await billingDatabase();
    const now = new Date("2026-01-10T00:00:00.000Z");

    const applied = await billing.extendPaidUntil(alice, "payment-1", 30, now);
    const replay = await billing.extendPaidUntil(alice, "payment-1", 30, now);

    expect(applied.applied).toBe(true);
    expect(replay.applied).toBe(false);
    expect(replay.paidUntil?.toISOString()).toBe(
      applied.paidUntil?.toISOString()
    );
    expect(
      (await billing.readBillingState(alice, now)).paidUntil?.toISOString()
    ).toBe("2026-02-09T00:00:00.000Z");
  }, 30_000);

  it("never lets a later notification undo an applied payment", async () => {
    const { billing } = await billingDatabase();
    const now = new Date("2026-01-10T00:00:00.000Z");

    await billing.recordPayment(alice, {
      amountRub: 2000,
      id: "payment-1",
      status: "pending",
    });
    await billing.extendPaidUntil(alice, "payment-1", 30, now);
    await billing.recordPayment(alice, {
      amountRub: 2000,
      id: "payment-1",
      status: "canceled",
    });

    expect(
      (await billing.readBillingState(alice, now)).paidUntil?.toISOString()
    ).toBe("2026-02-09T00:00:00.000Z");
  }, 30_000);
});

describe("usage counters", () => {
  it("counts each action once per workspace and period", async () => {
    const { usage } = await billingDatabase();

    expect(await usage.countUsage(alice, "messages", "2026-09-18")).toBe(1);
    expect(await usage.countUsage(alice, "messages", "2026-09-18")).toBe(2);
    // A different day, a different metered action and a different workspace
    // each start their own count.
    expect(await usage.countUsage(alice, "messages", "2026-09-19")).toBe(1);
    expect(await usage.countUsage(alice, "browser_runs", "2026-09")).toBe(1);
    expect(await usage.countUsage(bob, "messages", "2026-09-18")).toBe(1);
  }, 30_000);
});

describe("order records", () => {
  const order = {
    merchant: "wb" as const,
    merchantOrderId: "4600012345",
    priceRub: 1299,
    status: "placed" as const,
    title: "Кроссовки",
  };

  it("upserts an order on its merchant number and lists the newest first", async () => {
    const { orders } = await billingDatabase();

    const first = await orders.recordOrder(alice, {
      ...order,
      browserRunId: "run-1",
    });
    const replay = await orders.recordOrder(alice, {
      ...order,
      browserRunId: "run-1",
      pickup: "ПВЗ Ленина 1",
      status: "cancelled",
    });

    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe("cancelled");
    expect(replay.pickup).toBe("ПВЗ Ленина 1");
    expect(await orders.listOrders(alice)).toHaveLength(1);
    // The same merchant number in another workspace is a different order.
    await orders.recordOrder(bob, order);
    expect(await orders.listOrders(bob)).toHaveLength(1);
  }, 30_000);

  it("keeps the basket's lines when a later report of the order lists none", async () => {
    const { orders } = await billingDatabase();
    const items = [
      {
        name: "Корм Whiskas с кроликом, 1,9 кг",
        price: "649 ₽",
        quantity: "2",
      },
    ];

    await orders.recordOrder(alice, { ...order, items });
    // The run that only got 3-D Secure through reports the same number bare.
    const confirmed = await orders.recordOrder(alice, {
      ...order,
      items: null,
    });

    expect(confirmed.items).toEqual(items);
    expect((await orders.listOrders(alice))[0]?.items).toEqual(items);
  }, 30_000);

  it("lists each order with the site and the errand that placed it", async () => {
    // EN D4: «другой магазин» told the person nothing about the shop.
    const { browserRuns, orders } = await billingDatabase();
    const run = {
      conversationChannel: "telegram" as const,
      conversationId: "telegram:1",
      sessionId: "session-1",
      site: "https://lavka.yandex.ru",
      status: "done" as const,
    };
    await browserRuns.createBrowserRun(alice, {
      ...run,
      id: "run-lavka",
      submission: {
        forWhom: "Алиса",
        kind: "order",
        personalData: ["имя", "адрес"],
        what: "заказ продуктов к 20:00",
        where: "Яндекс Лавка (lavka.yandex.ru)",
      },
      task: "Оформи заказ по карточке",
    });
    await browserRuns.createBrowserRun(alice, {
      ...run,
      id: "run-plain",
      site: "https://shop.example",
      task: "Купи зарядку",
    });
    await orders.recordOrder(alice, {
      ...order,
      browserRunId: "run-lavka",
      merchant: "other",
      merchantOrderId: "L-1",
    });
    await orders.recordOrder(alice, {
      ...order,
      browserRunId: "run-plain",
      merchant: "other",
      merchantOrderId: "S-1",
    });
    // An order without its run, and one whose run id is another workspace's.
    await orders.recordOrder(alice, {
      ...order,
      merchant: "other",
      merchantOrderId: "X-1",
    });
    await orders.recordOrder(bob, {
      ...order,
      browserRunId: "run-lavka",
      merchant: "other",
      merchantOrderId: "B-1",
    });

    const listed = await orders.listOrders(alice);
    const byNumber = new Map(listed.map((row) => [row.merchantOrderId, row]));
    expect(byNumber.get("L-1")).toMatchObject({
      errand: "заказ продуктов к 20:00",
      site: "https://lavka.yandex.ru",
      where: "Яндекс Лавка (lavka.yandex.ru)",
    });
    expect(byNumber.get("S-1")).toMatchObject({
      errand: "Купи зарядку",
      site: "https://shop.example",
      where: null,
    });
    expect(byNumber.get("X-1")).toMatchObject({
      errand: null,
      site: null,
    });
    expect((await orders.listOrders(bob))[0]).toMatchObject({
      errand: null,
      site: null,
    });
  }, 30_000);
});

describe("workspace time zone", () => {
  it("round-trips a saved zone and falls back to Moscow", async () => {
    const { userProfile } = await billingDatabase();

    expect(await userProfile.readWorkspaceTimeZone(alice)).toBe(
      "Europe/Moscow"
    );

    const saved = await userProfile.patchUserProfile(alice, {
      timezone: "Asia/Novosibirsk",
    });

    expect(saved.timezone).toBe("Asia/Novosibirsk");
    expect(await userProfile.readWorkspaceTimeZone(alice)).toBe(
      "Asia/Novosibirsk"
    );
    expect((await userProfile.readUserProfile(alice)).timezone).toBe(
      "Asia/Novosibirsk"
    );

    await userProfile.patchUserProfile(alice, { timezone: null });
    expect(await userProfile.readWorkspaceTimeZone(alice)).toBe(
      "Europe/Moscow"
    );
  }, 30_000);
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

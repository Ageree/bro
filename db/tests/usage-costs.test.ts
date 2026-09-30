import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "better-auth:alice", workspaceId: "personal:alice" };
const bob = { userId: "better-auth:bob", workspaceId: "personal:bob" };

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

async function costsDatabase() {
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
  const [Database, scope, costs] = await Promise.all([
    import("@db"),
    import("@db/services/scope"),
    import("@db/services/usage-costs"),
  ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  await pgliteDatabase.insert(schema.user).values({
    email: "alice@example.com",
    id: "alice",
    name: "Alice",
  });
  return { costs, database: pgliteDatabase };
}

function cost(
  overrides: Partial<typeof schema.usageCosts.$inferInsert> & {
    readonly idempotencyKey: string;
  }
) {
  return {
    costRub: 1,
    occurredAt: new Date("2026-09-15T12:00:00.000Z"),
    source: "chat" as const,
    units: {},
    workspaceId: alice.workspaceId,
    ...overrides,
  };
}

// Each case migrates a fresh PGlite, which takes seconds on a busy machine.
describe("usage costs", { timeout: 30_000 }, () => {
  it("writes a cost once whatever retries it", async () => {
    const { costs, database } = await costsDatabase();

    expect(
      await costs.recordUsageCost(cost({ idempotencyKey: "step:s:t:0" }))
    ).toBe(true);
    expect(
      await costs.recordUsageCost(
        cost({ costRub: 5, idempotencyKey: "step:s:t:0" })
      )
    ).toBe(false);

    const rows = await database.select().from(schema.usageCosts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costRub).toBe(1);
  });

  it("refuses a negative cost and an unknown source", async () => {
    const { costs } = await costsDatabase();

    await expect(
      costs.recordUsageCost(cost({ costRub: -1, idempotencyKey: "negative" }))
    ).rejects.toThrow(/usage_costs/u);
    await expect(
      costs.recordUsageCost(
        // SAFETY: a source the type refuses reaches the database, whose check is under test.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the database check is what is under test.
        cost({ idempotencyKey: "unknown", source: "other" as never })
      )
    ).rejects.toThrow(/usage_costs/u);
  });

  it("sums a Moscow month per workspace by source, with its errands and the VM's fixed line", async () => {
    const { costs, database } = await costsDatabase();
    await database.insert(schema.browserVms).values({
      // Half of the Moscow September: 15 of its 30 days.
      createdAt: new Date("2026-09-15T21:00:00.000Z"),
      state: "stopped",
      vmId: "vm-1",
      workspaceId: alice.workspaceId,
    });
    const errand = "vm:personal:alice:r:1";
    const small = "run-2";
    await Promise.all(
      [
        cost({ costRub: 2.5, idempotencyKey: "a1" }),
        cost({ costRub: 1.5, idempotencyKey: "a2", source: "background" }),
        cost({
          costRub: 2,
          idempotencyKey: "a3",
          runId: errand,
          source: "browser-run",
        }),
        cost({
          costRub: 0.25,
          idempotencyKey: "a4",
          runId: errand,
          source: "proxy",
        }),
        cost({
          costRub: 3,
          idempotencyKey: "a5",
          runId: errand,
          source: "browser-report",
        }),
        cost({
          costRub: 0.75,
          idempotencyKey: "a6",
          runId: small,
          source: "browser-run",
        }),
        cost({ costRub: 1.2, idempotencyKey: "a7", source: "browser-vm" }),
        cost({
          costRub: 0,
          idempotencyKey: "a8",
          units: { inputTokens: 900, steps: 1, unpriced: true },
        }),
        // 00:30 on 1 October in Moscow belongs to October.
        cost({
          costRub: 100,
          idempotencyKey: "late",
          occurredAt: new Date("2026-09-30T21:30:00.000Z"),
        }),
        // 01:00 on 1 September in Moscow belongs to September.
        cost({
          costRub: 1,
          idempotencyKey: "early",
          occurredAt: new Date("2026-08-31T22:00:00.000Z"),
        }),
        cost({
          costRub: 4,
          idempotencyKey: "b1",
          workspaceId: bob.workspaceId,
        }),
      ].map(async (row) => costs.recordUsageCost(row))
    );

    const summary = await costs.summarizeUsageCosts(
      "2026-09",
      new Date("2026-10-05T12:00:00.000Z")
    );

    expect(summary.month).toBe("2026-09");
    expect(summary.workspaces.map((row) => row.workspaceId)).toEqual([
      alice.workspaceId,
      bob.workspaceId,
    ]);
    expect(summary.workspaces[0]).toEqual({
      bySource: {
        background: 1.5,
        "browser-report": 3,
        "browser-run": 2.75,
        "browser-vm": 1.2,
        chat: 3.5,
        proxy: 0.25,
      },
      errands: {
        averageRub: 3,
        count: 2,
        maxRub: 5.25,
        maxRunId: errand,
      },
      fixedVmRub: 131.5,
      ownerEmail: "alice@example.com",
      recordedRub: 12.2,
      totalRub: 143.7,
      unpricedRows: 1,
      workspaceId: alice.workspaceId,
    });
    expect(summary.workspaces[1]).toMatchObject({
      errands: { averageRub: 0, count: 0, maxRub: 0, maxRunId: null },
      fixedVmRub: 0,
      ownerEmail: null,
      totalRub: 4,
    });
    expect(summary.totalRub).toBe(147.7);

    // The month so far: 5 of September's 30 days.
    const current = await costs.summarizeUsageCosts(
      "2026-09",
      new Date("2026-09-20T21:00:00.000Z")
    );
    expect(current.workspaces[0]?.fixedVmRub).toBe(43.83);
    // A month before the VM: no fixed line, and no workspace without spend.
    const before = await costs.summarizeUsageCosts(
      "2026-08",
      new Date("2026-10-05T12:00:00.000Z")
    );
    expect(before.workspaces).toEqual([]);
  });

  it("breaks one errand down by source", async () => {
    const { costs } = await costsDatabase();
    const errand = "run-1";
    await costs.recordUsageCost(
      cost({
        costRub: 2,
        idempotencyKey: "r1",
        runId: errand,
        source: "browser-run",
        costUsd: 0.02,
      })
    );
    await costs.recordUsageCost(
      cost({
        costRub: 0.5,
        idempotencyKey: "r2",
        runId: errand,
        source: "browser-report",
      })
    );

    const breakdown = await costs.errandUsageCosts(errand);

    expect(breakdown).toMatchObject({
      bySource: { "browser-report": 0.5, "browser-run": 2 },
      runId: errand,
      totalRub: 2.5,
      workspaceId: alice.workspaceId,
    });
    expect(breakdown?.items).toHaveLength(2);
    expect(await costs.errandUsageCosts("nothing")).toBeUndefined();
  });

  it("reads a month only as YYYY-MM", async () => {
    const { costs } = await costsDatabase();
    await expect(costs.summarizeUsageCosts("2026-13")).rejects.toThrow(
      "A month is written as YYYY-MM."
    );
    expect(await costs.summarizeUsageCosts("2026-12")).toMatchObject({
      from: "2026-11-30T21:00:00.000Z",
      to: "2026-12-31T21:00:00.000Z",
      totalRub: 0,
      workspaces: [],
    });
  });
});

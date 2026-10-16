import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 30_000 });

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

async function service() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const Database = await import("@db");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  const scope = await import("@db/services/scope");
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return import("@db/services/direct-purchases");
}

describe("one request pays one purchase", () => {
  it("lets the purchase that took a request keep it, and no other take it", async () => {
    const { claimDirectPurchase } = await service();
    const request = { consentKey: "k".repeat(64) };
    expect(
      await claimDirectPurchase(alice, { ...request, ref: "browser:run-1" })
    ).toBe(true);
    expect(
      await claimDirectPurchase(alice, { ...request, ref: "browser:run-1" })
    ).toBe(true);
    expect(
      await claimDirectPurchase(alice, { ...request, ref: "yandex:order-2" })
    ).toBe(false);
    // Another workspace's request is its own.
    expect(
      await claimDirectPurchase(bob, { ...request, ref: "yandex:order-2" })
    ).toBe(true);
  });

  it("gives a request to one of two purchases racing for it", async () => {
    const { claimDirectPurchase } = await service();
    const consentKey = "r".repeat(64);
    const claimed = await Promise.all([
      claimDirectPurchase(alice, { consentKey, ref: "browser:a" }),
      claimDirectPurchase(alice, { consentKey, ref: "browser:b" }),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
  });
});

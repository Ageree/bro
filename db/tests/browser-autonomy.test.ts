import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as DatabaseModule from "@db";
import * as schema from "../schema";
import {
  type BrowserAutonomyPolicy,
  broadBrowserAutonomyPolicy,
  defaultBrowserAutonomyPolicy,
} from "@shared/browser/autonomy";

const databaseHolder = vi.hoisted<{
  current: ReturnType<typeof drizzle> | undefined;
}>(() => ({ current: undefined }));

vi.mock("@db", async (importOriginal) => {
  const original = await importOriginal<typeof DatabaseModule>();
  return {
    ...original,
    get db() {
      if (!databaseHolder.current)
        throw new Error("Expected a PGlite database.");
      return databaseHolder.current;
    },
  };
});

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const forgedAlice = { userId: "alice", workspaceId: "workspace:bob" };

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  databaseHolder.current = undefined;
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function autonomyDatabase() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const pgliteDatabase = drizzle(client, { schema });
  databaseHolder.current = pgliteDatabase;
  const [scope, autonomy] = await Promise.all([
    import("@db/services/scope"),
    import("@db/services/browser-autonomy"),
  ]);
  await scope.ensureScope(alice);
  await scope.ensureScope({ userId: "bob", workspaceId: "workspace:bob" });
  return { autonomy, client };
}

describe("browser autonomy persistence", () => {
  it("uses the safe default for absent and corrupt policy", async () => {
    const { autonomy, client } = await autonomyDatabase();

    await expect(autonomy.getBrowserAutonomyPolicy(alice)).resolves.toEqual(
      defaultBrowserAutonomyPolicy
    );
    await client.query(
      "INSERT INTO settings (workspace_id, key, value) VALUES ($1, 'browser_autonomy', $2)",
      [alice.workspaceId, "not-json"]
    );
    await expect(autonomy.getBrowserAutonomyPolicy(alice)).resolves.toEqual(
      defaultBrowserAutonomyPolicy
    );
  }, 20_000);

  it("round-trips a strictly validated policy for a member", async () => {
    const { autonomy } = await autonomyDatabase();

    await autonomy.setBrowserAutonomyPolicy(alice, broadBrowserAutonomyPolicy);

    await expect(autonomy.getBrowserAutonomyPolicy(alice)).resolves.toEqual(
      broadBrowserAutonomyPolicy
    );
    await autonomy.setBrowserAutonomyPolicy(
      alice,
      defaultBrowserAutonomyPolicy
    );
    await expect(autonomy.getBrowserAutonomyPolicy(alice)).resolves.toEqual(
      defaultBrowserAutonomyPolicy
    );
    const invalidPolicy: BrowserAutonomyPolicy = { version: 1, grants: [] };
    Object.defineProperty(invalidPolicy, "grants", { value: ["browse"] });
    await expect(
      autonomy.setBrowserAutonomyPolicy(alice, invalidPolicy)
    ).rejects.toThrow(/Invalid option/);
  }, 20_000);

  it("defaults reads and rejects writes without exact membership", async () => {
    const { autonomy } = await autonomyDatabase();

    await expect(
      autonomy.getBrowserAutonomyPolicy(forgedAlice)
    ).resolves.toEqual(defaultBrowserAutonomyPolicy);
    await expect(
      autonomy.setBrowserAutonomyPolicy(forgedAlice, broadBrowserAutonomyPolicy)
    ).rejects.toThrow("cannot change this workspace");
  }, 20_000);
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  const migrations = await Promise.all(
    names.map((name) => readFile(new URL(name, directory), "utf8"))
  );
  await migrations
    .flatMap((migration) => migration.split("--> statement-breakpoint"))
    .reduce(async (previous, statement) => {
      await previous;
      if (statement.trim()) {
        await database.exec(statement);
      }
    }, Promise.resolve());
}

import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MemoryDocumentConflictError } from "eve/memory/file";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@db/schema";

const databases: PGlite[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function loadDocuments() {
  // The spy and the module under test come from one module registry.
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface the service uses despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const Database = await import("@db");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  const { postgresMemoryDocuments } = await import("@agent/lib/profile-memory");
  return postgresMemoryDocuments;
}

describe("memory documents in Postgres", () => {
  it("creates once, then replaces only the version that was read", async () => {
    const documents = await loadDocuments();

    expect(await documents.read({ key: "scope-a", signal })).toBeNull();
    const created = await documents.write({
      content: "first",
      expectedVersion: null,
      key: "scope-a",
      signal,
    });
    expect(await documents.read({ key: "scope-a", signal })).toEqual(created);

    await expect(
      documents.write({
        content: "again",
        expectedVersion: null,
        key: "scope-a",
        signal,
      })
    ).rejects.toBeInstanceOf(MemoryDocumentConflictError);

    const replaced = await documents.write({
      content: "second",
      expectedVersion: created.version,
      key: "scope-a",
      signal,
    });
    expect(replaced.version).not.toBe(created.version);
    // A writer still holding the first version lost the race.
    await expect(
      documents.write({
        content: "stale",
        expectedVersion: created.version,
        key: "scope-a",
        signal,
      })
    ).rejects.toBeInstanceOf(MemoryDocumentConflictError);
    expect(await documents.read({ key: "scope-a", signal })).toEqual({
      content: "second",
      version: replaced.version,
    });
    expect(await documents.read({ key: "scope-b", signal })).toBeNull();
  }, 30_000);

  it("reads and saves nothing once the turn is aborted", async () => {
    const documents = await loadDocuments();
    const aborted = AbortSignal.abort(new Error("The turn was cancelled."));

    await expect(
      documents.write({
        content: "late",
        expectedVersion: null,
        key: "scope-a",
        signal: aborted,
      })
    ).rejects.toThrow("The turn was cancelled.");
    await expect(
      documents.read({ key: "scope-a", signal: aborted })
    ).rejects.toThrow("The turn was cancelled.");
    expect(await documents.read({ key: "scope-a", signal })).toBeNull();
  }, 30_000);

  it("treats a version it never issued as a conflict", async () => {
    const documents = await loadDocuments();

    await expect(
      documents.write({
        content: "x",
        expectedVersion: "etag-from-blob",
        key: "scope-a",
        signal,
      })
    ).rejects.toBeInstanceOf(MemoryDocumentConflictError);
  }, 30_000);
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../../db/migrations/", import.meta.url);
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

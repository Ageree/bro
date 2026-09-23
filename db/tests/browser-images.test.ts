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

async function browserImagesDatabase() {
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
  const [Database, browserImages] = await Promise.all([
    import("@db"),
    import("@db/services/browser-images"),
  ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  return { browserImages, pgliteDatabase };
}

function capture(idempotencyKey: string) {
  return {
    browserSessionId: "browser-session-1",
    byteSize: 3,
    contentHash:
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    filename: "final.png",
    idempotencyKey,
    label: "скриншот страницы с результатом",
    mediaType: "image/png",
    rootSessionId: "session-1",
    sourceKind: "viewport" as const,
    storagePathname: "browser-images/alice/039058c6",
    workerSessionId: "run-1",
  };
}

describe("browser image artifact persistence", () => {
  it("records a ready artifact the conversation that owns it can read", async () => {
    const { browserImages } = await browserImagesDatabase();

    const row = await browserImages.createReadyBrowserImageArtifact(
      alice,
      capture("browser-run:run-1:report/final.png")
    );

    expect(row.status).toBe("ready");
    expect(
      await browserImages.readReadyBrowserImageArtifact(alice, row.id, {
        rootSessionId: "session-1",
      })
    ).toMatchObject({
      byteSize: 3,
      createdByUserId: alice.userId,
      label: "скриншот страницы с результатом",
      mediaType: "image/png",
      workspaceId: alice.workspaceId,
    });
    expect(
      await browserImages.readReadyBrowserImageArtifact(alice, row.id, {
        rootSessionId: "another-session",
      })
    ).toBeUndefined();
    expect(
      await browserImages.readReadyBrowserImageArtifact(bob, row.id)
    ).toBeUndefined();
  }, 20_000);

  it("hands back the first row when the same capture is recorded again", async () => {
    const { browserImages, pgliteDatabase } = await browserImagesDatabase();
    const key = "browser-run:run-1:report/final.png";

    const first = await browserImages.createReadyBrowserImageArtifact(
      alice,
      capture(key)
    );
    const again = await browserImages.createReadyBrowserImageArtifact(alice, {
      ...capture(key),
      label: "a later label that must not replace the first",
    });
    const elsewhere = await browserImages.createReadyBrowserImageArtifact(
      bob,
      capture(key)
    );

    expect(again.id).toBe(first.id);
    expect(again.label).toBe("скриншот страницы с результатом");
    expect(elsewhere.id).not.toBe(first.id);
    expect(
      await pgliteDatabase.select().from(schema.browserImageArtifacts)
    ).toHaveLength(2);
  }, 20_000);
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

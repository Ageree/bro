import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import { claimWorkspaceIntroduction } from "@db/services/scope";

const client = new PGlite();
const database = drizzle(client, { schema });

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 20_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("workspace introduction", () => {
  // A voice note and its text, or a photo album, arrive as first messages at
  // the same moment; only one of them may carry the introduction.
  it("is claimed by exactly one of two simultaneous first messages", async () => {
    const scope = { userId: "alice", workspaceId: "workspace-alice" };

    const claims = await Promise.all([
      claimWorkspaceIntroduction(scope),
      claimWorkspaceIntroduction(scope),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimWorkspaceIntroduction(scope)).toBe(false);
  });

  // Workspaces older than the column have all met Bro, or came from Convex
  // with their history, so the migration marks them introduced.
  it("marks every workspace that predates the column as introduced", async () => {
    const legacy = new PGlite();
    try {
      const directory = new URL("../migrations/", import.meta.url);
      const names = (await readdir(directory))
        .filter((name) => name.endsWith(".sql"))
        .toSorted();
      const introducing = names.findIndex((name) => name.startsWith("0022_"));
      /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
      for (const [index, name] of names.entries()) {
        if (index === introducing) {
          await legacy.exec(
            "INSERT INTO workspaces (id) VALUES ('workspace-legacy')"
          );
        }
        const migration = await readFile(new URL(name, directory), "utf8");
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await legacy.exec(statement);
        }
      }
      /* oxlint-enable eslint/no-await-in-loop */
      const { rows } = await legacy.query<{ introduced: boolean }>(
        "SELECT introduced_at IS NOT NULL AS introduced FROM workspaces"
      );
      expect(introducing).toBeGreaterThan(0);
      expect(rows).toEqual([{ introduced: true }]);
    } finally {
      await legacy.close();
    }
  });

  it("is never claimed for a workspace that was already introduced", async () => {
    const scope = { userId: "bob", workspaceId: "workspace-bob" };
    await database.insert(schema.workspaces).values({
      id: scope.workspaceId,
      introducedAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect(await claimWorkspaceIntroduction(scope)).toBe(false);
    const [row] = await database
      .select({ introducedAt: schema.workspaces.introducedAt })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, scope.workspaceId));
    expect(row?.introducedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

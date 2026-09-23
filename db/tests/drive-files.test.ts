import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as Database from "@db";
import * as schema from "../schema";

const databases: PGlite[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("Drive file artifacts", () => {
  it("records one copy per session file version and resolves it only for its owner", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyAllMigrations(client);
    // SAFETY: PGlite implements the query-builder surface exercised by these services despite using a different Drizzle driver.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
    const database = drizzle(client, { schema }) as never;
    vi.spyOn(Database, "db", "get").mockReturnValue(database);

    const [scope, files, artifacts] = await Promise.all([
      import("@db/services/scope"),
      import("@db/services/drive-files"),
      import("@db/services/artifacts"),
    ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    await scope.ensureScope(alice);
    await scope.ensureScope(bob);

    const version = {
      driveFileId: "file-1",
      driveVersion: "7",
      rootSessionId: "session-alice",
    };
    const stored = {
      ...version,
      byteSize: 12,
      contentHash: "hash-1",
      filename: "Passport.pdf",
      mediaType: "application/pdf",
    };
    const first = await files.saveDriveFileArtifact(alice, {
      ...stored,
      id: "00000000-0000-4000-8000-0000000000d1",
      storagePathname: "drive-files/alice/first",
    });
    const replayed = await files.saveDriveFileArtifact(alice, {
      ...stored,
      id: "00000000-0000-4000-8000-0000000000d2",
      storagePathname: "drive-files/alice/second",
    });
    expect(replayed.id).toBe(first.id);

    const edited = await files.saveDriveFileArtifact(alice, {
      ...stored,
      driveVersion: "8",
      id: "00000000-0000-4000-8000-0000000000d3",
      storagePathname: "drive-files/alice/edited",
    });
    expect(edited.id).not.toBe(first.id);
    expect(await files.findDriveFileArtifact(bob, version)).toBeUndefined();

    expect(
      await artifacts.readReadyArtifact(alice, first.id, {
        rootSessionId: "session-alice",
      })
    ).toEqual({
      byteSize: 12,
      contentHash: "hash-1",
      filename: "Passport.pdf",
      id: first.id,
      mediaType: "application/pdf",
      storagePathname: "drive-files/alice/first",
    });
    expect(
      await artifacts.readReadyArtifact(alice, first.id, {
        rootSessionId: "another-session",
      })
    ).toBeUndefined();
    expect(await artifacts.readReadyArtifact(bob, first.id)).toBeUndefined();
  }, 30_000);
});

async function applyAllMigrations(database: PGlite) {
  const journal = z
    .object({ entries: z.array(z.object({ tag: z.string() })) })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../migrations/meta/_journal.json", import.meta.url),
          "utf8"
        )
      )
    );
  for (const { tag } of journal.entries) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Migrations apply in journal order.
    const migration = await readFile(
      new URL(`../migrations/${tag}.sql`, import.meta.url),
      "utf8"
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- Migrations apply in journal order.
    await database.exec(migration.replaceAll("--> statement-breakpoint", ""));
  }
}

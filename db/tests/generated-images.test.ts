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

describe("generated image artifacts", () => {
  it("records one picture per tool call and resolves it only for its owner", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyAllMigrations(client);
    // SAFETY: PGlite implements the query-builder surface exercised by these services despite using a different Drizzle driver.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
    const database = drizzle(client, { schema }) as never;
    vi.spyOn(Database, "db", "get").mockReturnValue(database);

    const [images, artifacts] = await Promise.all([
      import("@db/services/generated-images"),
      import("@db/services/artifacts"),
    ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    const picture = {
      byteSize: 8,
      contentHash: "hash-1",
      filename: "picture.png",
      idempotencyKey: "session-alice:turn-1:call-1",
      mediaType: "image/png",
      model: "test/image-model",
      prompt: "A birthday card with a dog",
      rootSessionId: "session-alice",
      storagePathname: "browser-images/alice/hash-1",
    };

    const first = await images.saveGeneratedImageArtifact(alice, picture);
    const replayed = await images.saveGeneratedImageArtifact(alice, {
      ...picture,
      contentHash: "hash-2",
      storagePathname: "browser-images/alice/hash-2",
    });

    expect(replayed.id).toBe(first.id);
    expect(
      await images.findGeneratedImageArtifact(alice, picture.idempotencyKey)
    ).toMatchObject({ contentHash: "hash-1", id: first.id });
    expect(
      await images.findGeneratedImageArtifact(bob, picture.idempotencyKey)
    ).toBeUndefined();
    expect(
      await artifacts.readReadyArtifact(alice, first.id, {
        rootSessionId: "session-alice",
      })
    ).toEqual({
      byteSize: 8,
      contentHash: "hash-1",
      filename: "picture.png",
      id: first.id,
      mediaType: "image/png",
      storagePathname: "browser-images/alice/hash-1",
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

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

describe("Gmail attachment artifacts", () => {
  it("records one copy per session part and resolves it only for its owner", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyAllMigrations(client);
    // SAFETY: PGlite implements the query-builder surface exercised by these services despite using a different Drizzle driver.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
    const database = drizzle(client, { schema }) as never;
    vi.spyOn(Database, "db", "get").mockReturnValue(database);

    const [scope, attachments, artifacts] = await Promise.all([
      import("@db/services/scope"),
      import("@db/services/gmail-attachments"),
      import("@db/services/artifacts"),
    ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    await scope.ensureScope(alice);
    await scope.ensureScope(bob);

    const part = {
      gmailMessageId: "message-1",
      gmailPartId: "1",
      rootSessionId: "session-alice",
    };
    const first = await attachments.saveGmailAttachmentArtifact(alice, {
      ...part,
      byteSize: 8,
      contentHash: "hash-1",
      filename: "beach.jpg",
      id: "00000000-0000-4000-8000-0000000000b1",
      mediaType: "image/jpeg",
      storagePathname: "gmail-attachments/alice/first",
    });
    const replayed = await attachments.saveGmailAttachmentArtifact(alice, {
      ...part,
      byteSize: 8,
      contentHash: "hash-1",
      filename: "beach.jpg",
      id: "00000000-0000-4000-8000-0000000000b2",
      mediaType: "image/jpeg",
      storagePathname: "gmail-attachments/alice/second",
    });

    expect(replayed.id).toBe(first.id);
    const laterSession = await attachments.saveGmailAttachmentArtifact(alice, {
      ...part,
      byteSize: 8,
      contentHash: "hash-1",
      filename: "beach.jpg",
      id: "00000000-0000-4000-8000-0000000000b3",
      mediaType: "image/jpeg",
      rootSessionId: "session-later",
      storagePathname: "gmail-attachments/alice/later",
    });
    expect(laterSession.id).not.toBe(first.id);
    expect(
      await attachments.findGmailAttachmentArtifact(alice, part)
    ).toMatchObject({ id: first.id });
    expect(
      await attachments.findGmailAttachmentArtifact(bob, part)
    ).toBeUndefined();

    expect(
      await artifacts.readReadyArtifact(alice, first.id, {
        rootSessionId: "session-alice",
      })
    ).toEqual({
      byteSize: 8,
      contentHash: "hash-1",
      filename: "beach.jpg",
      id: first.id,
      mediaType: "image/jpeg",
      storagePathname: "gmail-attachments/alice/first",
    });
    expect(await artifacts.readReadyArtifact(alice, first.id)).toBeDefined();
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

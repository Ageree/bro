import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Database from "@db";
import * as schema from "../schema";
import { browserImageArtifacts as browserImageArtifactsTable } from "../schema";

const databases: PGlite[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("database services", () => {
  it("preserves workspace ownership across application domains", async () => {
    const client = new PGlite();
    databases.push(client);
    await applyInitialMigration(client);
    await applyBrowserImageMigration(client);
    await applyBrowserTraceMigration(client);
    await applyBrowserTraceEventMigration(client);
    await applySchemaAdoptionMigration(client);
    await applyNativeTypesMigration(client);
    await applyChatChannelMigration(client);

    const pgliteDatabase = drizzle(client, { schema });
    // SAFETY: PGlite implements the query-builder surface exercised by these services despite using a different Drizzle driver.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
    const database = pgliteDatabase as never;
    vi.spyOn(Database, "db", "get").mockReturnValue(database);

    const [browserImages, chats, secrets, sessions, settings, scope, vault] =
      await Promise.all([
        import("@db/services/browser-images"),
        import("@db/services/chats"),
        import("@db/services/secrets"),
        import("@db/services/sessions"),
        import("@db/services/settings"),
        import("@db/services/scope"),
        import("@db/services/vault"),
      ]);
    const alice = { userId: "alice", workspaceId: "workspace:alice" };
    const bob = { userId: "bob", workspaceId: "workspace:bob" };

    await scope.ensureScope(alice);
    await scope.ensureScope(bob);

    const imageId = "00000000-0000-4000-8000-0000000000a1";
    await pgliteDatabase.insert(browserImageArtifactsTable).values({
      browserSessionId: "browser-alice",
      byteSize: 8,
      contentHash: "content-hash",
      createdAt: new Date(),
      createdByUserId: alice.userId,
      filename: "product.png",
      id: imageId,
      idempotencyKey: "worker-session:call-image",
      label: "Product image",
      mediaType: "image/png",
      rootSessionId: "session-alice",
      sourceKind: "viewport",
      status: "ready",
      storagePathname: "browser-images/alice/content-hash",
      workerSessionId: "worker-alice",
      workspaceId: alice.workspaceId,
    });

    const storedImage = await browserImages.readReadyBrowserImageArtifact(
      alice,
      imageId,
      { rootSessionId: "session-alice" }
    );
    expect(storedImage).toMatchObject({
      byteSize: 8,
      label: "Product image",
      mediaType: "image/png",
    });
    expect(storedImage?.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
    );
    expect(
      await browserImages.readReadyBrowserImageArtifact(alice, imageId, {
        rootSessionId: "another-session",
      })
    ).toBeUndefined();
    expect(
      await browserImages.readReadyBrowserImageArtifact(bob, imageId)
    ).toBeUndefined();

    await sessions.claimSession(alice, "session-alice");

    expect(await sessions.isSessionOwned(alice, "session-alice")).toBe(true);
    expect(await sessions.isSessionOwned(bob, "session-alice")).toBe(false);

    await sessions.claimSession(alice, "session-imessage");
    expect(await chats.listChats(alice)).toEqual([]);
    expect(await chats.hasConversationHistory(alice)).toBe(false);

    await sessions.claimSession(bob, "session-alice");
    expect(await sessions.isSessionOwned(alice, "session-alice")).toBe(true);
    expect(await sessions.isSessionOwned(bob, "session-alice")).toBe(false);

    await chats.saveChat(alice, {
      channel: "http",
      sessionId: "session-alice",
      title: "Initial title",
      usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 4 },
    });
    await chats.saveChat(alice, {
      sessionId: "session-alice",
      title: "Updated title",
    });
    await chats.saveChat(alice, {
      channel: "channel:photon",
      sessionId: "session-imessage",
    });

    expect(await chats.hasConversationHistory(alice)).toBe(true);
    expect(
      await chats.hasConversationHistory(alice, {
        exceptSessionId: "session-alice",
      })
    ).toBe(true);
    expect(await chats.hasConversationHistory(bob)).toBe(false);

    const aliceChat = await chats.readChat(alice, "session-alice");
    expect(aliceChat?.title).toBe("Updated title");
    expect(aliceChat?.channel).toBe("http");
    expect(aliceChat?.usage).toEqual({
      costUsd: 0.25,
      inputTokens: 10,
      outputTokens: 4,
    });
    expect(await chats.readChat(bob, "session-alice")).toBeUndefined();
    const indexedChats = await chats.listChats(alice);
    expect(indexedChats).toHaveLength(2);
    expect(
      indexedChats.find((chat) => chat.sessionId === "session-alice")
    ).toEqual(aliceChat);
    expect(
      indexedChats.find((chat) => chat.sessionId === "session-imessage")
    ).toMatchObject({ channel: "channel:photon", title: "New chat" });
    expect(await chats.listChats(bob)).toEqual([]);

    await chats.saveChat(bob, {
      sessionId: "session-alice",
      title: "Bob's title",
    });
    await chats.saveChat(bob, { sessionId: "session-unknown", title: "Probe" });
    expect(await chats.readChat(alice, "session-alice")).toEqual(aliceChat);
    expect(await chats.readChat(bob, "session-alice")).toBeUndefined();
    expect(await chats.readChat(bob, "session-unknown")).toBeUndefined();
    expect(await chats.listChats(bob)).toEqual([]);

    const { serializeLoginVaultPayload } = await import("@shared/vault/schema");
    await vault.saveVaultItem(alice, {
      account: "alice@example.com",
      kind: "login",
      label: "Alice",
      secret: serializeLoginVaultPayload({
        authentication: { password: "correct horse", type: "password" },
        identifier: { type: "email", value: "alice@example.com" },
        kind: "login",
        origin: "https://example.com",
        version: 2,
      }),
    });
    const [aliceVaultItem] = await vault.readVaultItems(alice);
    expect(aliceVaultItem).toMatchObject({ hasSecret: true, label: "Alice" });
    expect(await vault.readVaultItems(bob)).toEqual([]);
    expect(
      await vault.deleteVaultItem(bob, aliceVaultItem?.id ?? "vault-alice")
    ).toBe(false);

    const sharedSecretId = "00000000-0000-4000-8000-000000000099";
    await secrets.writeEncryptedSecret(
      alice,
      sharedSecretId,
      "ciphertext-alice"
    );
    await secrets.writeEncryptedSecret(bob, sharedSecretId, "ciphertext-bob");
    expect(await secrets.readEncryptedSecret(alice, sharedSecretId)).toBe(
      "ciphertext-alice"
    );
    expect(await secrets.readEncryptedSecret(bob, sharedSecretId)).toBe(
      "ciphertext-bob"
    );
    await secrets.deleteEncryptedSecret(alice, sharedSecretId);
    expect(
      await secrets.readEncryptedSecret(alice, sharedSecretId)
    ).toBeUndefined();
    expect(await secrets.readEncryptedSecret(bob, sharedSecretId)).toBe(
      "ciphertext-bob"
    );

    await settings.selectWorkspaceModel(alice, "openai/test");
    expect(await settings.getWorkspaceModelId(alice)).toBe("openai/test");
    expect(await settings.getWorkspaceModelId(bob)).toBe(
      "openai/gpt-5.6-sol-fast"
    );
  }, 15_000);
});

async function applyInitialMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0000_fluffy_the_spike.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applyBrowserImageMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0003_unusual_fabian_cortez.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applyBrowserTraceMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0004_kind_manta.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applyBrowserTraceEventMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0005_brave_kang.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applySchemaAdoptionMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0006_illegal_tattoo.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applyNativeTypesMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0008_black_sandman.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function applyChatChannelMigration(database: PGlite) {
  const migration = await readFile(
    new URL("../migrations/0011_faulty_unicorn.sql", import.meta.url),
    "utf8"
  );
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

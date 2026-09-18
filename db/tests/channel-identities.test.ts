/* oxlint-disable eslint/no-await-in-loop -- Migrations and their statements must be applied in order. */
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Database from "@db";
import * as schema from "../schema";

const databases: PGlite[] = [];

afterEach(async () => {
  // The service module stays cached so every test keeps the same `@db` module
  // instance the driver spy below replaces.
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("channel identities", () => {
  it("binds one Telegram account per workspace through single-use tokens", async () => {
    const identities = await migratedService();
    const ada = {
      userId: "better-auth:ada",
      workspaceId: "personal:ada",
    };
    const grace = {
      userId: "better-auth:grace",
      workspaceId: "personal:grace",
    };

    const token = await identities.mintChannelLinkToken(ada, "telegram");
    expect(token).toMatch(/^[\w-]{20,}$/u);

    await expect(
      identities.redeemChannelLinkToken("telegram", token, adaTelegram)
    ).resolves.toBe("linked");

    const linked = await identities.findChannelIdentity("telegram", "9001");
    expect(linked).toMatchObject({
      chatId: "4242",
      externalUserId: "9001",
      userId: "ada",
      username: "ada_lovelace",
      workspaceId: "personal:ada",
    });
    await expect(
      identities.readChannelIdentity(ada, "telegram")
    ).resolves.toMatchObject({ username: "ada_lovelace" });
    await expect(
      identities.readChannelIdentity(grace, "telegram")
    ).resolves.toBeUndefined();

    // The same token cannot be replayed once it has been consumed.
    await expect(
      identities.redeemChannelLinkToken("telegram", token, adaTelegram)
    ).resolves.toBe("unknown");
    await expect(
      identities.redeemChannelLinkToken("telegram", "never-minted", adaTelegram)
    ).resolves.toBe("unknown");
  }, 30_000);

  it("rejects a token that is older than its lifetime", async () => {
    const identities = await migratedService();
    const minted = new Date("2026-09-18T10:00:00.000Z");
    const token = await identities.mintChannelLinkToken(
      { userId: "better-auth:ada", workspaceId: "personal:ada" },
      "telegram",
      minted
    );

    await expect(
      identities.redeemChannelLinkToken(
        "telegram",
        token,
        adaTelegram,
        new Date(minted.getTime() + identities.channelLinkTokenLifetimeMs + 1)
      )
    ).resolves.toBe("expired");
    await expect(
      identities.findChannelIdentity("telegram", "9001")
    ).resolves.toBeUndefined();
  }, 30_000);

  it("keeps a Telegram account and an assistant account exclusive to each other", async () => {
    const identities = await migratedService();
    const ada = { userId: "better-auth:ada", workspaceId: "personal:ada" };
    const grace = {
      userId: "better-auth:grace",
      workspaceId: "personal:grace",
    };

    await identities.redeemChannelLinkToken(
      "telegram",
      await identities.mintChannelLinkToken(ada, "telegram"),
      adaTelegram
    );

    // Grace cannot claim the Telegram account Ada already owns.
    await expect(
      identities.redeemChannelLinkToken(
        "telegram",
        await identities.mintChannelLinkToken(grace, "telegram"),
        adaTelegram
      )
    ).resolves.toBe("already_linked_other_user");

    // Ada cannot attach a second Telegram account to the same workspace.
    await expect(
      identities.redeemChannelLinkToken(
        "telegram",
        await identities.mintChannelLinkToken(ada, "telegram"),
        { chatId: "7777", externalUserId: "9002", username: "ada_alt" }
      )
    ).resolves.toBe("already_linked_other_account");

    // Re-linking the same Telegram account refreshes its chat and handle.
    await expect(
      identities.redeemChannelLinkToken(
        "telegram",
        await identities.mintChannelLinkToken(ada, "telegram"),
        { chatId: "5150", externalUserId: "9001", username: "ada_l" }
      )
    ).resolves.toBe("linked");
    await expect(
      identities.findChannelIdentity("telegram", "9001")
    ).resolves.toMatchObject({ chatId: "5150", username: "ada_l" });
  }, 30_000);

  it("requires a Better Auth principal", async () => {
    const identities = await migratedService();

    await expect(
      identities.mintChannelLinkToken(
        { userId: "ada", workspaceId: "personal:ada" },
        "telegram"
      )
    ).rejects.toThrow("Better Auth account");
  }, 30_000);
});

const adaTelegram = {
  chatId: "4242",
  externalUserId: "9001",
  username: "ada_lovelace",
};

async function migratedService() {
  const client = new PGlite();
  databases.push(client);
  for (const migration of [
    "0000_fluffy_the_spike.sql",
    "0001_better-auth.sql",
    "0002_heavy_celestials.sql",
    "0003_unusual_fabian_cortez.sql",
    "0004_kind_manta.sql",
    "0005_brave_kang.sql",
    "0006_illegal_tattoo.sql",
    "0007_known_fenris.sql",
    "0008_black_sandman.sql",
    "0009_cold_power_man.sql",
    "0010_rapid_cerise.sql",
    "0011_faulty_unicorn.sql",
    "0012_harsh_domino.sql",
    "0013_last_christian_walker.sql",
    "0014_uneven_vector.sql",
    "0015_greedy_black_tom.sql",
  ]) {
    await applyMigration(client, migration);
  }
  await client.exec(`
    INSERT INTO "user" (id, name, email, "emailVerified", "updatedAt")
    VALUES
      ('ada', 'Ada', 'ada@example.com', false, now()),
      ('grace', 'Grace', 'grace@example.com', false, now());
  `);

  const pgliteDatabase = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface exercised by this service while retaining the shared Drizzle schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The focused test swaps only the database driver.
  vi.spyOn(Database, "db", "get").mockReturnValue(pgliteDatabase as never);
  return await import("@db/services/channel-identities");
}

async function applyMigration(database: PGlite, name: string) {
  const migration = await readFile(
    new URL(`../migrations/${name}`, import.meta.url),
    "utf8"
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}

import { randomBytes } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@db/schema";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  serializeLoginVaultPayload,
  serializePaymentCard,
} from "@shared/vault/schema";
import { encryptLegacyVaultSecret } from "../lib/legacy-vault.ts";
import type { ConvexMigrationOptions } from "../lib/migrate-from-convex.ts";

const ivanTenantId = "kd70ab1f4c1a2b3c4d5e6f70";
const ivanPhoneNumber = "+79210001122";
const mariaPhoneNumber = "+79219998877";
const disabledPhoneNumber = "+79215554433";

const legacyLoginSecret = JSON.stringify({
  authentication: { password: "correct horse battery", type: "password" },
  identifier: { type: "email", value: "ivan@example.com" },
  kind: "login",
  origin: "https://www.wildberries.ru",
  version: 1,
});

const legacyCardSecret = JSON.stringify({
  billingPostalCode: "630090",
  cardholderName: "IVAN PETROV",
  expirationMonth: 7,
  expirationYear: 2030,
  kind: "payment-card",
  number: "2204123412341234",
  securityCode: "123",
  version: 1,
});

const expectedLoginSecret = serializeLoginVaultPayload({
  authentication: { password: "correct horse battery", type: "password" },
  identifier: { type: "email", value: "ivan@example.com" },
  kind: "login",
  origin: "https://www.wildberries.ru",
  version: 2,
});

const expectedCardSecret = serializePaymentCard({
  billingPostalCode: "630090",
  cardholderName: "IVAN PETROV",
  expirationMonth: 7,
  expirationYear: 2030,
  kind: "payment-card",
  number: "2204123412341234",
  securityCode: "123",
  version: 1,
});

const databases: PGlite[] = [];

afterEach(async () => {
  // The stubs from tests/setup-env.ts are file-scoped, so only the mocks and
  // the module registry are reset between cases.
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("Convex import", () => {
  it("creates each person once and writes nothing on a dry run", async () => {
    const exportDirectory = await writeConvexExport();
    const { database, migration } = await migrationDatabase();
    const options = migrationOptions(exportDirectory);

    const planned = await migration.migrateFromConvex({
      ...options,
      dryRun: true,
    });
    expect(planned.migrated).toBe(2);
    expect(planned.skipped).toBe(1);
    expect(planned.failed).toBe(0);
    expect(planned.tenants[0]?.account).toBe("new");
    expect(await database.select().from(schema.user)).toEqual([]);
    expect(await database.select().from(schema.workspaces)).toEqual([]);
    expect(await database.select().from(schema.vaultItems)).toEqual([]);

    const first = await migration.migrateFromConvex(options);
    expect(first.failed).toBe(0);
    expect(first.tenants.map((tenant) => tenant.status)).toEqual([
      "migrated",
      "migrated",
      "skipped",
    ]);
    const [ivan] = first.tenants;
    expect(ivan?.account).toBe("created");
    expect(ivan?.profileFields).toEqual(["firstName", "lastName", "timezone"]);
    expect(ivan?.vault).toEqual({ created: 2, existing: 0, failed: 0 });
    expect(ivan?.telegram).toBe("linked");

    const users = await database.select().from(schema.user);
    expect(users).toHaveLength(2);
    expect(users.map((row) => row.phoneNumber ?? "").toSorted()).toEqual([
      ivanPhoneNumber,
      mariaPhoneNumber,
    ]);
    expect(users.every((row) => row.phoneNumber !== disabledPhoneNumber)).toBe(
      true
    );

    const scope = workspaceScope(users, ivanPhoneNumber);
    const [profile] = await database
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.workspaceId, scope.workspaceId));
    expect(profile?.firstName).toBe("Иван");
    expect(profile?.lastName).toBe("Петров");
    expect(profile?.timezone).toBe("Asia/Novosibirsk");

    const [billing] = await database.select().from(schema.billingAccounts);
    expect(billing?.paidUntil?.toISOString()).toBe(
      new Date(1_793_491_200_000).toISOString()
    );

    const [payment] = await database.select().from(schema.payments);
    expect(payment?.id).toBe("2f3b8a10-000f-5000-a000-1d7b2c9e4a11");
    expect(payment?.amountRub).toBe(2000);
    expect(payment?.status).toBe("succeeded");

    const [order] = await database.select().from(schema.orders);
    expect(order?.merchantOrderId).toBe("WB-91827364");
    expect(order?.pickup).toBe("ПВЗ Ленина 5");
    expect(order?.priceRub).toBe(1490);

    const [identity] = await database.select().from(schema.channelIdentities);
    expect(identity?.externalUserId).toBe("5550001");
    expect(identity?.username).toBe("ivan");
    expect(identity?.userId).toBe(
      users.find((row) => row.phoneNumber === ivanPhoneNumber)?.id
    );

    const second = await migration.migrateFromConvex(options);
    expect(second.failed).toBe(0);
    expect(second.tenants[0]?.account).toBe("reused");
    expect(second.tenants[0]?.vault).toEqual({
      created: 0,
      existing: 2,
      failed: 0,
    });
    expect(await database.select().from(schema.user)).toHaveLength(2);
    expect(await database.select().from(schema.workspaces)).toHaveLength(2);
    expect(await database.select().from(schema.vaultItems)).toHaveLength(2);
    expect(await database.select().from(schema.payments)).toHaveLength(1);
    expect(await database.select().from(schema.orders)).toHaveLength(1);
  }, 60_000);

  it("re-encrypts vault items under the installation key", async () => {
    const exportDirectory = await writeConvexExport();
    const { database, migration, vault } = await migrationDatabase();

    await migration.migrateFromConvex(migrationOptions(exportDirectory));

    const scope = workspaceScope(
      await database.select().from(schema.user),
      ivanPhoneNumber
    );
    const items = await database
      .select()
      .from(schema.vaultItems)
      .where(eq(schema.vaultItems.workspaceId, scope.workspaceId));
    expect(items.map((item) => item.label).toSorted()).toEqual([
      "Wildberries",
      "Карта МИР",
    ]);

    const login = items.find((item) => item.kind === "login");
    const card = items.find((item) => item.kind === "payment");
    expect(await vault.readVaultSecret(scope, login?.id ?? "")).toBe(
      expectedLoginSecret
    );
    expect(await vault.readVaultSecret(scope, card?.id ?? "")).toBe(
      expectedCardSecret
    );

    // The stored ciphertext is this installation's, not the old deployment's.
    const secrets = await database.select().from(schema.encryptedSecrets);
    expect(secrets).toHaveLength(2);
    expect(
      secrets.every((secret) => !secret.encryptedValue.includes("correct"))
    ).toBe(true);
  }, 60_000);

  it("reports a broken vault item without stopping the run", async () => {
    const exportDirectory = await writeConvexExport();
    const secrets = join(exportDirectory, "vaultSecrets", "documents.jsonl");
    await writeFile(
      secrets,
      (await readFile(secrets, "utf8")).replace('"v1.', '"v1.AA'),
      "utf8"
    );
    const { database, migration } = await migrationDatabase();

    const summary = await migration.migrateFromConvex(
      migrationOptions(exportDirectory)
    );

    expect(summary.failed).toBe(1);
    expect(summary.migrated).toBe(1);
    const [ivan] = summary.tenants;
    expect(ivan?.status).toBe("failed");
    expect(ivan?.vault).toEqual({ created: 1, existing: 0, failed: 1 });
    // Everything that did not depend on the broken ciphertext still landed.
    expect(await database.select().from(schema.vaultItems)).toHaveLength(1);
    expect(await database.select().from(schema.orders)).toHaveLength(1);
    expect(await database.select().from(schema.payments)).toHaveLength(1);
    expect(ivan?.notes.join(" ")).not.toContain(ivanPhoneNumber);
  }, 60_000);

  it("keeps whole phone numbers out of its output", async () => {
    const exportDirectory = await writeConvexExport();
    const { migration } = await migrationDatabase();
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await migration.migrateFromConvex(migrationOptions(exportDirectory));

    const output = logged.mock.calls.flat().join("\n");
    expect(output).toContain("••••1122");
    expect(output).not.toContain(ivanPhoneNumber);
    expect(output).not.toContain(mariaPhoneNumber);
    expect(output).not.toContain("ivan@example.com");
    expect(output).not.toContain("2204123412341234");
  }, 60_000);
});

function migrationOptions(exportDirectory: string): ConvexMigrationOptions {
  return {
    dryRun: false,
    exportDirectory,
    onlyPhoneNumbers: [],
    registerPhoton: false,
    skipVault: false,
  };
}

/**
 * Builds a Convex export whose ciphertexts were written by the legacy scheme
 * under a key this run generated. Nothing encrypted is checked into the tree,
 * and the decrypt path has to do real work to satisfy the assertions.
 */
async function writeConvexExport() {
  const vaultKey = randomBytes(32).toString("base64");
  vi.stubEnv("BRO_VAULT_KEY", vaultKey);

  const directory = await mkdtemp(join(tmpdir(), "convex-export-"));
  await cp(
    fileURLToPath(new URL("fixtures/convex-export/", import.meta.url)),
    directory,
    { recursive: true }
  );

  const master = Buffer.from(vaultKey, "base64");
  const secrets = [
    { handle: "vlt_wb_login", plaintext: legacyLoginSecret },
    { handle: "vlt_mir_card", plaintext: legacyCardSecret },
  ].map((secret, index) =>
    JSON.stringify({
      _creationTime: 1_789_000_000_000 + index,
      _id: `kw44ab1f4c1a2b3c4d5e6f0${String(index)}`,
      ciphertext: encryptLegacyVaultSecret(
        master,
        ivanTenantId,
        secret.handle,
        secret.plaintext
      ),
      handle: secret.handle,
      tenantId: ivanTenantId,
      updatedAt: 1_789_000_000_000 + index,
    })
  );
  await mkdir(join(directory, "vaultSecrets"), { recursive: true });
  await writeFile(
    join(directory, "vaultSecrets", "documents.jsonl"),
    `${secrets.join("\n")}\n`,
    "utf8"
  );
  return directory;
}

async function migrationDatabase() {
  // The spy and the modules under test have to share one module registry, so
  // the reset happens before either of them is imported.
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const pgliteDatabase = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = pgliteDatabase as never;
  const Database = await import("@db");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);

  const [migration, vault] = await Promise.all([
    import("../lib/migrate-from-convex.ts"),
    import("@db/services/vault"),
  ]);
  return { database: pgliteDatabase, migration, vault };
}

function workspaceScope(
  users: readonly (typeof schema.user.$inferSelect)[],
  phoneNumber: string
) {
  const owner = users.find((row) => row.phoneNumber === phoneNumber);
  if (!owner) throw new Error("The migrated account is missing.");
  return accessScopeForUser(`better-auth:${owner.id}`);
}

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

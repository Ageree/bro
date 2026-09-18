import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as Database from "@db";
import * as schema from "../../../schema";

let client: PGlite | undefined;

beforeAll(async () => {
  client = new PGlite();
  await applyMigrations(client);
}, 30_000);

beforeEach(async () => {
  const database = client;
  if (!database) throw new Error("The test database is required.");
  await database.exec(
    'TRUNCATE TABLE workspace_memberships, workspaces, "user" CASCADE'
  );
  const pgliteDatabase = drizzle(database, { schema });
  // SAFETY: PGlite implements the query-builder surface exercised by this service despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const swapped = pgliteDatabase as never;
  vi.spyOn(Database, "db", "get").mockReturnValue(swapped);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client?.close();
});

describe("iMessage phone onboarding", () => {
  it("creates one verified user and its workspace, then reuses it", async () => {
    const { ensureVerifiedPhoneUser } =
      await import("@db/services/auth/phone-user");

    const created = await ensureVerifiedPhoneUser("+12025550123");
    const reused = await ensureVerifiedPhoneUser("+12025550123");

    expect(created?.created).toBe(true);
    expect(reused).toEqual({ created: false, userId: created?.userId });
    await expect(phoneUsers()).resolves.toEqual([
      {
        id: created?.userId,
        name: "Phone user",
        phoneNumber: "+12025550123",
        phoneNumberVerified: true,
      },
    ]);
    await expect(workspaceOwners()).resolves.toEqual([
      `better-auth:${String(created?.userId)}`,
    ]);
  });

  it("creates one user when two first messages arrive at once", async () => {
    const { ensureVerifiedPhoneUser } =
      await import("@db/services/auth/phone-user");

    const [first, second] = await Promise.all([
      ensureVerifiedPhoneUser("+12025550123"),
      ensureVerifiedPhoneUser("+12025550123"),
    ]);

    expect(first?.userId).toBeDefined();
    expect(second?.userId).toBe(first?.userId);
    // Exactly one of the two racing messages may greet the new person.
    expect([first?.created, second?.created].filter(Boolean)).toHaveLength(1);
    await expect(phoneUsers()).resolves.toHaveLength(1);
  });

  it("refuses a phone number whose account is not verified", async () => {
    await Database.db.insert(schema.user).values({
      email: "someone@example.com",
      id: "user-unverified",
      name: "Someone",
      phoneNumber: "+12025550124",
      phoneNumberVerified: false,
    });
    const { ensureVerifiedPhoneUser } =
      await import("@db/services/auth/phone-user");

    await expect(
      ensureVerifiedPhoneUser("+12025550124")
    ).resolves.toBeUndefined();
  });
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../../../migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  /* oxlint-disable eslint/no-await-in-loop -- Migrations and their statements must execute in file order. */
  for (const file of files) {
    const migration = await readFile(new URL(file, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

function phoneUsers() {
  return Database.db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      phoneNumber: schema.user.phoneNumber,
      phoneNumberVerified: schema.user.phoneNumberVerified,
    })
    .from(schema.user);
}

async function workspaceOwners() {
  const memberships = await Database.db
    .select({ userId: schema.workspaceMemberships.userId })
    .from(schema.workspaceMemberships);
  return memberships.map((membership) => membership.userId);
}

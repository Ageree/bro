import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import * as schema from "@db/schema";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 60_000 });

const argv = process.argv;

/** What the script puts to the PUT URL: the links, never printed. */
const uploadSchema = z.object({
  accounts: z.array(z.object({ key: z.string(), link: z.string() })),
});

/** What the script prints to the job's log. */
const printedSchema = z.object({
  accounts: z.array(z.object({ created: z.boolean(), key: z.string() })),
  phoneNumberRequests: z.number(),
  phoneNumbers: z.number(),
});

afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv("PHONE_AUTO_PROVISION", "off");
  vi.stubEnv("PHONE_WORKSPACES", "");
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

/** One run of the ops script on this database, as deployd starts it. */
async function ensureTestAccounts(client: PGlite) {
  vi.resetModules();
  // SAFETY: PGlite implements the query-builder surface the script uses despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const Database = await import("@db");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  const uploads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { readonly body: string }) => {
      uploads.push(init.body);
      return new Response(null, { status: 200 });
    })
  );
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    printed.push(line);
  });
  process.argv = [
    "node",
    "test-accounts.mjs",
    "ensure",
    "https://storage.example/result",
  ];
  await import("../cloudru-app-host/ops/test-accounts.ts");
  return { printed: printed.join("\n"), uploads };
}

describe("production's test accounts", () => {
  it("makes the web-only accounts once, and no phone number is ever queued for them", async () => {
    vi.stubEnv("PHONE_AUTO_PROVISION", "on");
    vi.stubEnv("PHONE_WORKSPACES", "*");
    const client = new PGlite();
    await applyMigrations(client);

    const first = await ensureTestAccounts(client);
    expect(first.uploads).toHaveLength(1);
    const { accounts: links } = uploadSchema.parse(
      JSON.parse(first.uploads[0] ?? "{}")
    );
    expect(links.map((account) => account.key)).toEqual([
      "anya",
      "boris",
      "vika",
      "gosha",
    ]);
    for (const { link } of links)
      expect(new URL(link).pathname).toBe("/api/auth/telegram-login/open");
    expect(first.printed).not.toContain("?t=");
    expect(printedSchema.parse(JSON.parse(first.printed))).toMatchObject({
      phoneNumberRequests: 0,
      phoneNumbers: 0,
    });
    const second = await ensureTestAccounts(client);
    expect(
      printedSchema
        .parse(JSON.parse(second.printed))
        .accounts.map((account) => account.created)
    ).toEqual([false, false, false, false]);

    const accounts = await client.query<{
      email: string;
      first_name: string;
      phone: string | null;
      timezone: string;
      user_id: string;
      workspace_id: string;
    }>(`
      SELECT u.email, u."phoneNumber" AS phone, m.user_id, m.workspace_id, p.first_name, p.timezone
      FROM "user" u
      JOIN workspace_memberships m ON m.user_id = 'better-auth:' || u.id
      JOIN user_profiles p ON p.workspace_id = m.workspace_id
      ORDER BY u.email
    `);
    expect(
      accounts.rows.map(({ email, first_name, phone, timezone }) => ({
        email,
        first_name,
        phone,
        timezone,
      }))
    ).toEqual([
      {
        email: "bro-test-anya@telegram.local-vault.invalid",
        first_name: "Аня",
        phone: null,
        timezone: "Asia/Yekaterinburg",
      },
      {
        email: "bro-test-boris@telegram.local-vault.invalid",
        first_name: "Борис",
        phone: null,
        timezone: "Europe/Moscow",
      },
      {
        email: "bro-test-gosha@telegram.local-vault.invalid",
        first_name: "Гоша",
        phone: null,
        timezone: "Europe/Moscow",
      },
      {
        email: "bro-test-vika@telegram.local-vault.invalid",
        first_name: "Вика",
        phone: null,
        timezone: "Europe/Moscow",
      },
    ]);

    // The web chat ensures the scope on every message; the workspace is there already.
    const { ensureScope } = await import("@db/services/scope");
    for (const { user_id: userId, workspace_id: workspaceId } of accounts.rows)
      // oxlint-disable-next-line eslint/no-await-in-loop -- One message after another, as the web chat sends them.
      await ensureScope({ userId, workspaceId });
    const requests = await client.query(
      "SELECT workspace_id FROM phone_number_requests"
    );
    expect(requests.rows).toEqual([]);
    await client.close();
  });
});

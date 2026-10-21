import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@db/schema";
import type * as Environment from "@shared/environment";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof Environment>();
  return {
    ...original,
    env: { ...original.env, TELEGRAM_BOT_USERNAME: "bro_test_bot" },
    localPhoneAuthBypassEnabled: false,
  };
});
vi.mock("@db/services/installation-secrets", () => ({
  getInstallationSecrets: async () => ({
    betterAuthSecret: "telegram-login-test-secret-0123456789abcdef",
  }),
}));

const databases: PGlite[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function withDatabase() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const Database = await import("@db");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
}

/** Opens a sign-in link the way a browser does after the bot's button. */
async function browser() {
  await withDatabase();
  const { getAuth } = await import("@db/services/auth");
  const auth = await getAuth();
  const { applicationOrigin } = await import("@shared/environment/origin");
  const origin = new URL(applicationOrigin()).origin;
  return {
    open: async (token: string) =>
      auth.handler(
        new Request(
          `${origin}/api/auth/telegram-login/open?t=${encodeURIComponent(token)}`,
          { headers: { "x-forwarded-for": "203.0.113.50" } }
        )
      ),
    origin,
  };
}

const ada = { chatId: "4242", name: "Ada", telegramUserId: "9001" };

describe("an account from Telegram", () => {
  it("is made once for a Telegram user, however many first messages race", async () => {
    await withDatabase();
    const { ensureTelegramUser } =
      await import("@db/services/auth/telegram-user");

    const accounts = await Promise.all([
      ensureTelegramUser(ada),
      ensureTelegramUser(ada),
    ]);
    const again = await ensureTelegramUser(ada);

    expect(new Set(accounts.map((account) => account?.userId)).size).toBe(1);
    expect(accounts.filter((account) => account?.created)).toHaveLength(1);
    expect(again).toEqual({ created: false, userId: accounts[0]?.userId });
  });
});

describe("signing in through the Telegram bot", () => {
  it("signs the browser in with the bot's button, once", async () => {
    const { open, origin } = await browser();
    const { ensureTelegramUser } =
      await import("@db/services/auth/telegram-user");
    const { mintTelegramLoginLink } =
      await import("@db/services/auth/telegram-login");
    const account = await ensureTelegramUser(ada);
    const token = await mintTelegramLoginLink(account?.userId ?? "");

    const signedIn = await open(token);
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("location")).toBe(`${origin}/workspace`);
    const cookie = signedIn.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("session_token");

    const { getAuthSession } = await import("@db/services/auth/session");
    const session = await getAuthSession(
      new Headers({ cookie: cookie.split(";")[0] ?? "" })
    );
    expect(session?.user).toMatchObject({
      id: account?.userId,
      phoneNumber: undefined,
    });

    // The link signed one browser in; it opens nothing again.
    const again = await open(token);
    expect(again.headers.get("location")).toBe(
      `${origin}/sign-in?telegram=expired`
    );
    expect(again.headers.get("set-cookie") ?? "").not.toContain(
      "session_token="
    );
  });

  it("opens nothing with a link that ran out of time or was never made", async () => {
    const { open, origin } = await browser();
    const { mintTelegramLoginLink } =
      await import("@db/services/auth/telegram-login");
    const stale = await mintTelegramLoginLink(
      "user-1",
      new Date(Date.now() - 11 * 60_000)
    );

    for (const token of [stale, "never-made"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each link is opened on its own.
      const answer = await open(token);
      expect(answer.headers.get("location")).toBe(
        `${origin}/sign-in?telegram=expired`
      );
    }
  });
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../../../migrations/", import.meta.url);
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

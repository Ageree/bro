import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
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

/** The website's requests, as the sign-in page sends them. */
async function website() {
  await withDatabase();
  const { getAuth } = await import("@db/services/auth");
  const auth = await getAuth();
  const { applicationOrigin } = await import("@shared/environment/origin");
  const origin = new URL(applicationOrigin()).origin;
  const post = async (
    path: string,
    body?: { readonly code: string; readonly token: string }
  ) =>
    auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        body: JSON.stringify(body ?? {}),
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": "203.0.113.50",
        },
        method: "POST",
      })
    );
  return {
    start: async () =>
      startedSchema.parse(await (await post("/telegram-login/start")).json()),
    verify: async (token: string, code: string) =>
      post("/telegram-login/verify", { code, token }),
  };
}

const startedSchema = z.object({ token: z.string(), url: z.string() });
const refusalCode = async (answer: Response) =>
  z.object({ code: z.string() }).parse(await answer.json()).code;

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
  it("signs the browser in with the code the bot sent, once", async () => {
    const { start, verify } = await website();
    const { token, url } = await start();
    expect(url).toBe(`https://t.me/bro_test_bot?start=login_${token}`);

    // Before Start is pressed there is no code to check.
    await expect(refusalCode(await verify(token, "000000"))).resolves.toBe(
      "TELEGRAM_LOGIN_PENDING"
    );

    const { ensureTelegramUser } =
      await import("@db/services/auth/telegram-user");
    const { approveTelegramLogin } =
      await import("@db/services/auth/telegram-login");
    const account = await ensureTelegramUser(ada);
    const approved = await approveTelegramLogin(token, account?.userId ?? "");
    if (approved.kind !== "code") throw new Error("The bot must get a code.");

    const signedIn = await verify(token, approved.code);
    expect(signedIn.status).toBe(200);
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

    // The code signed one browser in; it opens nothing again.
    await expect(refusalCode(await verify(token, approved.code))).resolves.toBe(
      "TELEGRAM_LOGIN_EXPIRED"
    );
  });

  it("ends the login after three wrong codes", async () => {
    const { start, verify } = await website();
    const { token } = await start();
    const { approveTelegramLogin } =
      await import("@db/services/auth/telegram-login");
    const { ensureTelegramUser } =
      await import("@db/services/auth/telegram-user");
    const account = await ensureTelegramUser(ada);
    const approved = await approveTelegramLogin(token, account?.userId ?? "");
    if (approved.kind !== "code") throw new Error("The bot must get a code.");
    const wrong = approved.code === "111111" ? "222222" : "111111";

    const answers: string[] = [];
    for (const _ of [1, 2, 3]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each guess waits for the one before it.
      answers.push(await refusalCode(await verify(token, wrong)));
    }

    expect(answers).toEqual([
      "TELEGRAM_CODE_WRONG",
      "TELEGRAM_CODE_WRONG",
      "TELEGRAM_LOGIN_EXPIRED",
    ]);
    expect((await verify(token, approved.code)).status).toBe(400);
  });

  it("gives another Telegram account nothing and keeps the wrong guesses", async () => {
    const { start, verify } = await website();
    const { token } = await start();
    const { approveTelegramLogin } =
      await import("@db/services/auth/telegram-login");
    const first = await approveTelegramLogin(token, "user-1");
    if (first.kind !== "code") throw new Error("The bot must get a code.");
    const wrong = first.code === "111111" ? "222222" : "111111";
    await verify(token, wrong);
    await verify(token, wrong);

    await expect(approveTelegramLogin(token, "user-2")).resolves.toEqual({
      kind: "unknown",
    });
    // Start pressed again: a new code, but no fresh guesses.
    const again = await approveTelegramLogin(token, "user-1");
    if (again.kind !== "code") throw new Error("The bot must get a code.");
    const wrongAgain = again.code === "111111" ? "222222" : "111111";
    await expect(refusalCode(await verify(token, wrongAgain))).resolves.toBe(
      "TELEGRAM_LOGIN_EXPIRED"
    );
  });

  it("gives no code for a login that ran out of time", async () => {
    await withDatabase();
    const { approveTelegramLogin, startTelegramLogin } =
      await import("@db/services/auth/telegram-login");
    const started = new Date("2026-10-21T10:00:00Z");
    const token = await startTelegramLogin(started);

    await expect(
      approveTelegramLogin(token, "user-1", new Date("2026-10-21T10:11:00Z"))
    ).resolves.toEqual({ kind: "expired" });
    await expect(approveTelegramLogin("never-made", "user-1")).resolves.toEqual(
      { kind: "unknown" }
    );
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

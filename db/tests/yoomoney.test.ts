import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };
const origin = "https://bro.example";

/** YooMoney as the wallet API answers, by path; each request recorded. */
function wallet(answers: Record<string, () => Response>) {
  const requests: { path: string; body: string; authorization: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init: RequestInit) => {
      const path = new URL(input).pathname;
      requests.push({
        path,
        body: String(init.body),
        authorization: new Headers(init.headers).get("Authorization") ?? "",
      });
      const answer = answers[path];
      if (!answer) throw new Error(`Unexpected request to ${path}`);
      return answer();
    })
  );
  return requests;
}

const json = (body: object, status = 200) => Response.json(body, { status });

const consenting = {
  "/oauth/token": () => json({ access_token: "token-1" }),
  "/api/account-info": () =>
    json({
      account: "4100111222333",
      balance: 1250.5,
      currency: "643",
      account_status: "identified",
      account_type: "personal",
    }),
  "/api/revoke": () => new Response(null, { status: 200 }),
};

beforeEach(() => {
  vi.stubEnv("YOOMONEY_CLIENT_ID", "client-1");
  vi.stubEnv("YOOMONEY_CLIENT_SECRET", "secret-1");
  vi.stubEnv("YOOMONEY_WORKSPACES", "*");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function service() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const [Database, scope, yoomoney] = await Promise.all([
    import("@db"),
    import("@db/services/scope"),
    import("@db/services/yoomoney"),
  ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return yoomoney;
}

/** The state YooMoney would send back: from the consent page's Redirect URI. */
function stateOf(consentUrl: string) {
  const redirect = new URL(consentUrl).searchParams.get("redirect_uri") ?? "";
  return new URL(redirect).searchParams.get("state") ?? "";
}

describe("the YooMoney wallet connection", () => {
  it("connects the wallet with the token the code of the person's own state gives", async () => {
    const yoomoney = await service();
    const consent = await yoomoney.startYoomoneyAuthorization(alice, origin);
    const page = new URL(consent);
    expect(page.origin + page.pathname).toBe(
      "https://yoomoney.ru/oauth/authorize"
    );
    expect(page.searchParams.get("scope")).toBe(
      "account-info operation-history"
    );
    const state = stateOf(consent);
    const requests = wallet(consenting);

    // Bob cannot spend Alice's state, and a spent state does not come back.
    await expect(
      yoomoney.finishYoomoneyAuthorization(bob, "code-1", state)
    ).rejects.toThrow("истекла");
    expect(
      await yoomoney.finishYoomoneyAuthorization(alice, "code-1", state)
    ).toEqual({ account: "4100111222333" });
    await expect(
      yoomoney.finishYoomoneyAuthorization(alice, "code-1", state)
    ).rejects.toThrow("истекла");

    const token = new URLSearchParams(requests[0]?.body);
    expect(token.get("client_secret")).toBe("secret-1");
    expect(token.get("redirect_uri")).toBe(
      `${origin}/api/yoomoney/callback?state=${state}`
    );
    expect(requests[1]?.authorization).toBe("Bearer token-1");
    expect(await yoomoney.readYoomoneyConnection(alice)).toMatchObject({
      state: "connected",
      account: "4100111222333",
    });
    expect(await yoomoney.readYoomoneyConnection(bob)).toEqual({
      state: "disconnected",
    });
    expect(
      await yoomoney.withYoomoneyToken(alice, async (stored) => stored)
    ).toEqual({ connected: true, result: "token-1" });
  });

  it("stores nothing when YooMoney gives no token for the code", async () => {
    const yoomoney = await service();
    const state = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    wallet({ "/oauth/token": () => json({ access_token: "" }) });
    await expect(
      yoomoney.finishYoomoneyAuthorization(alice, "wrong", state)
    ).rejects.toThrow("ЮMoney");
    expect(await yoomoney.readYoomoneyConnection(alice)).toEqual({
      state: "disconnected",
    });
  });

  it("forgets the wallet once YooMoney refuses its token", async () => {
    const yoomoney = await service();
    const state = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    wallet(consenting);
    await yoomoney.finishYoomoneyAuthorization(alice, "code-1", state);
    wallet({ "/api/account-info": () => new Response(null, { status: 401 }) });
    const { readYoomoneyAccount } = await import("@shared/yoomoney/api");
    await expect(
      yoomoney.withYoomoneyToken(alice, readYoomoneyAccount)
    ).rejects.toThrow("Подключи кошелёк заново");
    expect(await yoomoney.readYoomoneyConnection(alice)).toEqual({
      state: "disconnected",
    });
  });

  it("ends the token at YooMoney when the person disconnects", async () => {
    const yoomoney = await service();
    const state = stateOf(
      await yoomoney.startYoomoneyAuthorization(alice, origin)
    );
    const requests = wallet(consenting);
    await yoomoney.finishYoomoneyAuthorization(alice, "code-1", state);
    expect(await yoomoney.disconnectYoomoney(alice)).toEqual({
      disconnected: true,
    });
    expect(requests.at(-1)).toMatchObject({
      path: "/api/revoke",
      authorization: "Bearer token-1",
    });
    expect(await yoomoney.readYoomoneyConnection(alice)).toEqual({
      state: "disconnected",
    });
  });
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../migrations/", import.meta.url);
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

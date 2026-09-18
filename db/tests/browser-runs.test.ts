import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };
const runId = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function browserRunsDatabase() {
  // The spy and the services under test have to come from one module registry,
  // so the reset happens before both are imported.
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const pgliteDatabase = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = pgliteDatabase as never;
  const [Database, scope, browserRuns] = await Promise.all([
    import("@db"),
    import("@db/services/scope"),
    import("@db/services/browser-runs"),
  ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return browserRuns;
}

function conversation() {
  return {
    conversationChannel: "photon" as const,
    conversationId: "imessage:chat-1",
    replyAnchorMessageId: "message-1",
    rootSessionId: "session-1",
    sessionId: "browser-session-1",
    task: "Order the usual",
  };
}

describe("browser run persistence", () => {
  it("keeps one Browser Use profile per workspace", async () => {
    const browserRuns = await browserRunsDatabase();

    expect(await browserRuns.readBrowserProfileId(alice)).toBeUndefined();
    expect(await browserRuns.saveBrowserProfileId(alice, "profile-1")).toBe(
      "profile-1"
    );
    expect(await browserRuns.saveBrowserProfileId(alice, "profile-2")).toBe(
      "profile-1"
    );
    expect(await browserRuns.readBrowserProfileId(bob)).toBeUndefined();
  }, 20_000);

  it("scopes a run to the workspace that started it", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, { ...conversation(), id: runId });

    expect(
      (await browserRuns.readBrowserRunForScope(alice, runId))?.status
    ).toBe("created");
    expect(
      await browserRuns.readBrowserRunForScope(bob, runId)
    ).toBeUndefined();
    expect((await browserRuns.readBrowserRun(runId))?.workspaceId).toBe(
      alice.workspaceId
    );
  }, 20_000);

  it("settles a run once and stops listing it as unsettled", async () => {
    const browserRuns = await browserRunsDatabase();
    await browserRuns.createBrowserRun(alice, {
      ...conversation(),
      id: runId,
      status: "running",
    });
    await browserRuns.updateBrowserRunProgress(runId, {
      liveViewUrl: "https://live.browser-use.test/abc",
    });

    const future = new Date(Date.now() + 60_000);
    expect(
      await browserRuns.listUnsettledBrowserRuns({
        limit: 10,
        staleBefore: future,
      })
    ).toHaveLength(1);

    const claimed = await browserRuns.claimBrowserRunCompletion(runId, {
      outcome: "Result: ordered",
      status: "done",
    });
    const second = await browserRuns.claimBrowserRunCompletion(runId, {
      outcome: "Result: ordered again",
      status: "done",
    });

    expect(claimed?.liveViewUrl).toBe("https://live.browser-use.test/abc");
    expect(claimed?.completedAt).toBeInstanceOf(Date);
    expect(second).toBeUndefined();
    expect(
      await browserRuns.listUnsettledBrowserRuns({
        limit: 10,
        staleBefore: future,
      })
    ).toEqual([]);
    expect((await browserRuns.readBrowserRun(runId))?.outcome).toBe(
      "Result: ordered"
    );
  }, 20_000);
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

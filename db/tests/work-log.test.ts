import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "better-auth:alice", workspaceId: "personal:alice" };
const bob = { userId: "better-auth:bob", workspaceId: "personal:bob" };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
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

async function logDatabase() {
  // The spy and the service under test have to come from one module
  // registry, so the reset happens before both are imported.
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const pgliteDatabase = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = pgliteDatabase as never;
  const Database = await import("@db");
  const scope = await import("@db/services/scope");
  const log = await import("@db/services/work-log");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return { client, database: pgliteDatabase, log };
}

const web = "channel:eve";

// Each case migrates a fresh PGlite, which takes seconds on a busy machine.
describe("work log", { timeout: 30_000 }, () => {
  it("keeps a line once when its turn's step runs again, cut to 2000 characters", async () => {
    const { database, log } = await logDatabase();
    const line = {
      channel: web,
      files: [],
      role: "bro" as const,
      sessionId: "docs",
      text: `Разобрал договор. ${"слово ".repeat(500)}`,
      turnId: "turn_3",
    };

    await log.appendWorkLine(alice.workspaceId, line);
    await log.appendWorkLine(alice.workspaceId, {
      ...line,
      createdAt: new Date(Date.now() + 1000),
    });
    await log.appendWorkLine(alice.workspaceId, { ...line, text: "   " });

    const rows = await database.select().from(schema.workLog);
    expect(rows).toHaveLength(1);
    expect(Array.from(rows[0]?.text ?? "")).toHaveLength(2000);
  });

  it("reads the workspace's newest lines of other chats since a moment, oldest first", async () => {
    const { log } = await logDatabase();
    let turn = 0;
    const append = async (
      minutesAgo: number,
      sessionId: string,
      text: string,
      workspaceId = alice.workspaceId
    ) => {
      turn += 1;
      await log.appendWorkLine(workspaceId, {
        channel: web,
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
        files: [],
        role: "person",
        sessionId,
        text,
        turnId: `turn_${String(turn)}`,
      });
    };
    await append(60, "docs", "давнее");
    await append(5, "docs", "один");
    await append(4, "voice", "этот чат");
    await append(3, "tasks", "два");
    await append(2, "tasks", "три");
    await append(1, "bob", "боб", bob.workspaceId);

    const lines = await log.readWorkLines(alice.workspaceId, {
      excludeSession: "voice",
      limit: 2,
      since: new Date(Date.now() - 30 * 60_000),
    });
    expect(lines.map(({ text }) => text)).toEqual(["два", "три"]);
  });

  it("forgets lines after 30 days in the hourly pass, and a workspace's lines of a period", async () => {
    const { client, database, log } = await logDatabase();
    await client.query(
      `INSERT INTO work_log (workspace_id, session_id, turn_id, channel, role, text, created_at)
       VALUES
         ('personal:alice', 'docs', 'turn_1', 'channel:eve', 'bro', 'старое', now() - interval '31 days'),
         ('personal:alice', 'docs', 'turn_2', 'channel:eve', 'bro', 'свежее', now() - interval '29 days'),
         ('personal:bob', 'docs', 'turn_1', 'channel:eve', 'bro', 'чужое', now())`
    );
    const texts = async () =>
      (await database.select().from(schema.workLog))
        .map(({ text }) => text)
        .toSorted();

    await log.expireWorkLines();
    expect(await texts()).toEqual(["свежее", "чужое"]);
    expect(
      await log.lastWorkLineOfSession(alice.workspaceId, "docs")
    ).toBeInstanceOf(Date);

    // «Забудь, где я был вчера»: the lines of the period only.
    await log.forgetWorkLines(alice.workspaceId, {
      from: new Date(Date.now() - 30 * 24 * 60 * 60_000),
      to: new Date(Date.now() - 28 * 24 * 60 * 60_000),
    });
    expect(await texts()).toEqual(["чужое"]);
  });
});

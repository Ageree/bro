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
  const log = await import("@db/services/conversation-log");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return { client, database: pgliteDatabase, log };
}

const telegram = "channel:telegram";
const web = "channel:eve";

// Each case migrates a fresh PGlite, which takes seconds on a busy machine.
describe("conversation log", { timeout: 30_000 }, () => {
  it("keeps a line cut to 500 characters and nothing for an empty one", async () => {
    const { database, log } = await logDatabase();

    await log.appendConversationLine(alice.workspaceId, {
      channel: telegram,
      sessionId: "tg",
      text: `  ${"😀".repeat(600)}  `,
      turnId: "turn_0",
    });
    await log.appendConversationLine(alice.workspaceId, {
      channel: telegram,
      sessionId: "tg",
      text: "   ",
      turnId: "turn_1",
    });

    const rows = await database.select().from(schema.conversationLog);
    expect(rows).toHaveLength(1);
    expect(Array.from(rows[0]?.text ?? "")).toHaveLength(500);
  });

  // eve hooks are at-least-once: a re-run step emits its message again,
  // with a new event time.
  it("keeps a message once when its turn's step runs again", async () => {
    const { database, log } = await logDatabase();
    const line = {
      channel: telegram,
      sessionId: "tg",
      text: "Напомни про Казань",
      turnId: "turn_3",
    };

    await log.appendConversationLine(alice.workspaceId, line);
    await log.appendConversationLine(alice.workspaceId, {
      ...line,
      createdAt: new Date(Date.now() + 1000),
    });
    // The same words in the next turn are a new line.
    await log.appendConversationLine(alice.workspaceId, {
      ...line,
      turnId: "turn_4",
    });

    const rows = await database.select().from(schema.conversationLog);
    expect(rows.map(({ turnId }) => turnId).toSorted()).toEqual([
      "turn_3",
      "turn_4",
    ]);
  });

  it("refuses a text the table does not hold", async () => {
    const { client } = await logDatabase();

    await expect(
      client.query(
        `INSERT INTO conversation_log (workspace_id, session_id, turn_id, channel, text)
         VALUES ('personal:alice', 's', 'turn_0', 'channel:eve', '')`
      )
    ).rejects.toThrow(/conversation_log_text_check/u);
  });

  it("reads the person's latest lines of other channels since a moment, oldest first", async () => {
    const { log } = await logDatabase();
    let turn = 0;
    const append = async (
      minutesAgo: number,
      line: { channel: string; sessionId: string; text: string },
      workspaceId = alice.workspaceId
    ) => {
      turn += 1;
      await log.appendConversationLine(workspaceId, {
        ...line,
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
        turnId: `turn_${String(turn)}`,
      });
    };
    await append(5, { channel: telegram, sessionId: "tg", text: "один" });
    await append(4, { channel: web, sessionId: "web-1", text: "веб" });
    await append(3, { channel: telegram, sessionId: "tg", text: "два" });
    await append(2, { channel: telegram, sessionId: "tg", text: "три" });
    await append(
      1,
      { channel: telegram, sessionId: "tg-bob", text: "боб" },
      bob.workspaceId
    );

    const lines = await log.readRecapLines(alice.workspaceId, {
      excludeChannel: web,
      limit: 2,
      since: new Date(0),
    });
    expect(lines.map(({ text }) => text)).toEqual(["два", "три"]);

    const spoke = await log.lastLineOfConversation(alice.workspaceId, {
      sessionId: "web-1",
    });
    expect(spoke).toBeInstanceOf(Date);
    const since = await log.readRecapLines(alice.workspaceId, {
      excludeChannel: web,
      limit: 12,
      since: spoke ?? new Date(0),
    });
    expect(since.map(({ text }) => text)).toEqual(["два", "три"]);

    expect(
      await log.lastLineOfConversation(alice.workspaceId, {
        channel: "channel:photon",
      })
    ).toBeUndefined();
    expect(
      (
        await log.lastLineOfConversation(alice.workspaceId, {
          channel: telegram,
        })
      )?.getTime()
    ).toBeGreaterThanOrEqual(spoke?.getTime() ?? 0);
  });

  it("forgets every line after 14 days in the hourly pass, and every line with the workspace", async () => {
    const { client, database, log } = await logDatabase();
    const seed = async () => {
      await client.query(
        `INSERT INTO conversation_log (workspace_id, session_id, turn_id, channel, text, created_at)
         VALUES
           ('personal:alice', 'tg', 'turn_1', 'channel:telegram', 'старое', now() - interval '15 days'),
           ('personal:alice', 'tg', 'turn_2', 'channel:telegram', 'свежее', now() - interval '13 days'),
           ('personal:bob', 'tg', 'turn_1', 'channel:telegram', 'чужое', now() - interval '15 days')
         ON CONFLICT DO NOTHING`
      );
    };
    const texts = async () =>
      (await database.select().from(schema.conversationLog))
        .map(({ text }) => text)
        .toSorted();
    await seed();

    // Review of item 28: a new line deletes nothing — a sweep over every
    // workspace on each message cost every turn of the pilot.
    await log.appendConversationLine(alice.workspaceId, {
      channel: web,
      sessionId: "web",
      text: "новое",
      turnId: "turn_0",
    });
    expect(await texts()).toEqual(["новое", "свежее", "старое", "чужое"]);

    // The hourly pass expires them, Bob's too though he writes no more.
    await log.expireConversationLines();
    expect(await texts()).toEqual(["новое", "свежее"]);

    await client.query(`DELETE FROM workspaces WHERE id = 'personal:alice'`);
    expect(await texts()).toEqual([]);
  });

  it("forgets a workspace's lines at once, and no one else's", async () => {
    const { client, database, log } = await logDatabase();
    await client.query(
      `INSERT INTO conversation_log (workspace_id, session_id, turn_id, channel, text)
       VALUES
         ('personal:alice', 'tg', 'turn_1', 'channel:telegram', 'адрес'),
         ('personal:bob', 'tg', 'turn_1', 'channel:telegram', 'чужое')`
    );

    await log.forgetConversationLines(alice.workspaceId);

    const rows = await database.select().from(schema.conversationLog);
    expect(rows.map(({ text }) => text)).toEqual(["чужое"]);
  });
});

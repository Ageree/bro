import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as Database from "@db";
import * as chats from "@db/services/chats";
import { ensureScope } from "@db/services/scope";
import * as sessions from "@db/services/sessions";
import * as schema from "../schema";

const client = new PGlite();
const database = drizzle(client, { schema });
const alice = { userId: "alice", workspaceId: "workspace:alice" };

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the query-builder surface exercised by this service despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
  await ensureScope(alice);
}, 60_000);

afterAll(() => client.close());

it("names a chat Новый чат until a message names it, and shows the old English default the same", async () => {
  await sessions.claimSession(alice, "chat-new");
  await chats.saveChat(alice, { sessionId: "chat-new" });
  // Rows written before the default was Russian stay as they are.
  await database.insert(schema.chats).values([
    {
      sessionId: "chat-legacy",
      title: "New chat",
      workspaceId: alice.workspaceId,
    },
    {
      sessionId: "chat-named",
      title: "Билеты в Казань",
      workspaceId: alice.workspaceId,
    },
  ]);

  const [stored] = await database
    .select({ title: schema.chats.title })
    .from(schema.chats)
    .where(eq(schema.chats.sessionId, "chat-new"));
  expect(stored?.title).toBe("Новый чат");
  const [legacy] = await database
    .select({ title: schema.chats.title })
    .from(schema.chats)
    .where(eq(schema.chats.sessionId, "chat-legacy"));
  expect(legacy?.title).toBe("New chat");

  const { chats: listed } = await chats.listChatsPage(alice);
  expect(
    Object.fromEntries(listed.map((chat) => [chat.sessionId, chat.title]))
  ).toEqual({
    "chat-legacy": "Новый чат",
    "chat-named": "Билеты в Казань",
    "chat-new": "Новый чат",
  });
  expect((await chats.readChat(alice, "chat-legacy"))?.title).toBe("Новый чат");
});

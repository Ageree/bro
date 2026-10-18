import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as Database from "@db";
import * as schema from "../schema";

const client = new PGlite();
const database = drizzle(client, { schema });

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the query-builder surface exercised by this service despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 60_000);

afterAll(() => client.close());

it("pages «Все чаты» by cursor and counts the totals of every chat", async () => {
  const chats = await import("@db/services/chats");
  const alice = { userId: "alice", workspaceId: "workspace:alice" };
  await database
    .insert(schema.workspaces)
    .values([{ id: alice.workspaceId }, { id: "workspace:bob" }]);

  // Every three chats share one moment: the cursor must not skip or repeat them.
  const at = (index: number) =>
    new Date(Date.UTC(2026, 9, 1) - Math.floor(index / 3) * 60_000);
  const total = chats.chatPageSize * 2 + 5;
  await database.insert(schema.chats).values([
    ...Array.from({ length: total }, (_, index) => ({
      channel:
        index === 4 || index === 90
          ? "channel:telegram"
          : index === 60
            ? "channel:photon"
            : "http",
      costUsd: index === 7 ? null : 0.01,
      createdAt: at(index),
      inputTokens: index === 7 ? 0 : 10,
      outputTokens: 2,
      sessionId: `chat-${String(index).padStart(3, "0")}`,
      title: `Чат ${index}`,
      updatedAt: at(index),
      workspaceId: alice.workspaceId,
    })),
    {
      costUsd: 5,
      inputTokens: 1000,
      outputTokens: 1000,
      sessionId: "bob-chat",
      title: "Bob",
      workspaceId: "workspace:bob",
    },
  ]);

  const seen: string[] = [];
  let page = await chats.listChatsPage(alice);
  seen.push(...page.chats.map((chat) => chat.sessionId));
  while (page.next) {
    expect(page.chats).toHaveLength(chats.chatPageSize);
    page = await chats.listChatsPage(alice, page.next);
    seen.push(...page.chats.map((chat) => chat.sessionId));
  }
  expect(page.chats).toHaveLength(5);
  // Newest first; within one moment, by session id descending.
  expect(seen.slice(0, 3)).toEqual(["chat-002", "chat-001", "chat-000"]);
  expect(new Set(seen).size).toBe(total);

  const totals = await chats.summarizeChats(alice);
  expect(totals.count).toBe(total);
  expect(totals.usage.inputTokens).toBe((total - 1) * 10);
  expect(totals.usage.outputTokens).toBe(total * 2);
  // The chat without a cost spent tokens only as output: the total cost is unknown.
  expect(totals.usage.costUsd).toBeNull();

  // The newest telegram chat is the main thread even when it is past page one.
  const newest = await chats.newestChatsOfChannels(alice, [
    "channel:photon",
    "channel:telegram",
  ]);
  expect(newest).toEqual(
    expect.arrayContaining([
      { channel: "channel:photon", sessionId: "chat-060" },
      { channel: "channel:telegram", sessionId: "chat-004" },
    ])
  );
  expect(newest).toHaveLength(2);
});

it("prices the totals only when every chat that spent tokens has a cost", async () => {
  const chats = await import("@db/services/chats");
  const scope = { userId: "u", workspaceId: "w" };
  expect(await chats.summarizeChats(scope)).toEqual({
    count: 0,
    usage: { costUsd: null, inputTokens: 0, outputTokens: 0 },
  });
  await database.insert(schema.workspaces).values({ id: "w" });
  await database.insert(schema.chats).values([
    {
      costUsd: 0.012,
      inputTokens: 1200,
      outputTokens: 300,
      sessionId: "a",
      title: "A",
      workspaceId: "w",
    },
    {
      costUsd: 0.008,
      inputTokens: 800,
      outputTokens: 200,
      sessionId: "b",
      title: "B",
      workspaceId: "w",
    },
    // A chat that has spent nothing does not make the cost unknown.
    {
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      sessionId: "c",
      title: "C",
      workspaceId: "w",
    },
  ]);
  const totals = await chats.summarizeChats(scope);
  expect(totals.count).toBe(3);
  expect(totals.usage.inputTokens).toBe(2000);
  expect(totals.usage.outputTokens).toBe(500);
  expect(totals.usage.costUsd).toBeCloseTo(0.02, 10);
});

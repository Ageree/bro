import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const fromRunId = "queued:synthetic-order";
const dispatchId = "pending:dispatch:queue:queued%3Asynthetic-order:0";
const retry = {
  conversationChannel: "eve" as const,
  conversationId: "session-1",
  id: "synthetic-acknowledged-run",
  paymentAllowed: true,
  rootSessionId: "session-1",
  sessionId: "synthetic-browser-session",
  status: "running" as const,
  task: "Закажи воду",
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("@db");
  await Promise.all(databases.splice(0).map((client) => client.close()));
});

async function database() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  const migrations = await Promise.all(
    names.map((name) => readFile(new URL(name, directory), "utf8"))
  );
  await migrations.reduce(async (previous, migration) => {
    await previous;
    await client.exec(migration);
  }, Promise.resolve());
  const db = drizzle(client, { schema });
  vi.doMock("@db", () => ({ ...schema, db }));
  const runs = await import("@db/services/browser-runs");
  await db
    .insert(schema.workspaces)
    .values([{ id: alice.workspaceId }, { id: "workspace:bob" }]);
  await db.insert(schema.workspaceMemberships).values({
    ...alice,
    role: "owner",
  });
  await db.insert(schema.browserRuns).values({
    ...retry,
    createdByUserId: alice.userId,
    id: fromRunId,
    pendingTask: retry.task,
    status: "queued",
    workspaceId: alice.workspaceId,
  });
  return { db, runs };
}

function reservation() {
  return {
    amountRub: 354,
    browserRunId: dispatchId,
    feeRub: 20,
    id: "original-reservation",
    periodKey: "2026-09",
    source: "limit" as const,
    status: "reserved" as const,
    workspaceId: alice.workspaceId,
  };
}

describe("atomic browser payment handoff", () => {
  it("moves the dispatch reservation with the acknowledged run without changing exposure", async () => {
    const test = await database();
    await test.db.insert(schema.spendEntries).values(reservation());

    expect(
      await test.runs.handOffBrowserRunRetry(fromRunId, retry, {
        queueRevision: 0,
        spendDispatchId: dispatchId,
      })
    ).toBe(true);
    expect(await test.runs.readBrowserRun(fromRunId)).toMatchObject({
      pendingTask: null,
      retriedAsRunId: retry.id,
      status: "stopped",
    });
    expect(await test.runs.readBrowserRun(retry.id)).toMatchObject({
      ...retry,
      createdByUserId: alice.userId,
      workspaceId: alice.workspaceId,
    });
    expect(await test.db.select().from(schema.spendEntries)).toMatchObject([
      { ...reservation(), browserRunId: retry.id },
    ]);
  }, 30_000);

  it.each(["missing", "released", "charged", "foreign"] as const)(
    "rolls back the entire handoff for a %s dispatch reservation",
    async (condition) => {
      const test = await database();
      if (condition !== "missing") {
        await test.db.insert(schema.spendEntries).values({
          ...reservation(),
          status: condition === "foreign" ? "reserved" : condition,
          workspaceId:
            condition === "foreign" ? "workspace:bob" : alice.workspaceId,
        });
      }
      const before = await test.db.select().from(schema.spendEntries);

      await expect(
        test.runs.handOffBrowserRunRetry(fromRunId, retry, {
          spendDispatchId: dispatchId,
        })
      ).rejects.toThrow("payment dispatch reservation is unavailable");
      expect(await test.runs.readBrowserRun(fromRunId)).toMatchObject({
        pendingTask: retry.task,
        retriedAsRunId: null,
        status: "queued",
      });
      expect(await test.runs.readBrowserRun(retry.id)).toBeUndefined();
      expect(await test.db.select().from(schema.spendEntries)).toEqual(before);
    },
    30_000
  );

  it("does not move a dispatch reservation when the queue revision changed", async () => {
    const test = await database();
    await test.db.insert(schema.spendEntries).values(reservation());
    await test.db
      .update(schema.browserRuns)
      .set({ queueRevision: 1 })
      .where(eq(schema.browserRuns.id, fromRunId));

    expect(
      await test.runs.handOffBrowserRunRetry(fromRunId, retry, {
        queueRevision: 0,
        spendDispatchId: dispatchId,
      })
    ).toBe(false);
    expect(await test.runs.readBrowserRun(retry.id)).toBeUndefined();
    expect(await test.db.select().from(schema.spendEntries)).toMatchObject([
      reservation(),
    ]);
  }, 30_000);
});

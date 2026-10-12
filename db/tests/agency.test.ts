/* oxlint-disable eslint/no-await-in-loop -- Migrations and their statements must be applied in order. */
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { beginAgencyAction } from "@db/services/agency";
import * as schema from "../schema";

const databases: PGlite[] = [];
let migrated: Promise<Blob> | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };
const telegram = {
  conversationChannel: "telegram" as const,
  conversationId: "100::",
};
const now = new Date("2026-10-12T09:00:00.000Z");

function plan(
  inputHash: string,
  actionClass: "send" | "calendar" | "call" | "submit" | "other" = "send",
  workspaceId = alice.workspaceId
) {
  return {
    workspaceId,
    runId: "run-1",
    tool: "send_message",
    actionClass,
    counterparty: "Анна",
    inputHash,
    summary: "Письмо Анне отправлено",
    undo: null,
  };
}

function startedId(result: Awaited<ReturnType<typeof beginAgencyAction>>) {
  if (result.kind !== "started") throw new Error("Expected a new action.");
  return result.id;
}

// The first case migrates the shared template database, which takes seconds.
describe("agency actions", { timeout: 30_000 }, () => {
  it("recognizes a repeated action as a duplicate, per workspace", async () => {
    const { agency } = await openDatabase();

    expect(await agency.beginAgencyAction(plan("h1"))).toMatchObject({
      kind: "started",
    });
    expect(await agency.beginAgencyAction(plan("h1"))).toEqual({
      kind: "duplicate",
    });
    expect(
      await agency.beginAgencyAction(plan("h1", "send", bob.workspaceId))
    ).toMatchObject({ kind: "started" });
  });

  it("counts planned and done actions per class, and settles each row once", async () => {
    const { agency } = await openDatabase();
    const since = new Date(Date.now() - 60_000);

    const sent = startedId(await agency.beginAgencyAction(plan("send-1")));
    const failed = startedId(
      await agency.beginAgencyAction(plan("calendar-1", "calendar"))
    );
    const reversed = startedId(
      await agency.beginAgencyAction(plan("submit-1", "submit"))
    );
    const pending = startedId(
      await agency.beginAgencyAction(plan("call-1", "call"))
    );
    startedId(await agency.beginAgencyAction(plan("other-1", "other")));
    startedId(
      await agency.beginAgencyAction(plan("send-bob", "send", bob.workspaceId))
    );

    expect(await agency.finishAgencyAction(sent, "done")).toBe(true);
    expect(await agency.finishAgencyAction(failed, "failed")).toBe(true);
    expect(await agency.finishAgencyAction(reversed, "done")).toBe(true);
    expect(await agency.markAgencyActionUndone(reversed)).toBe(true);

    // A settled row is never settled again, and only a done row can be undone.
    expect(await agency.finishAgencyAction(sent, "failed")).toBe(false);
    expect(await agency.markAgencyActionUndone(pending)).toBe(false);

    // Failed and undone actions do not count; planned ones do, until settled.
    expect(
      Object.fromEntries(
        await agency.agencyBudgetUsage(alice.workspaceId, since)
      )
    ).toEqual({ send: 1, calendar: 0, call: 1, submit: 0, other: 1 });
    expect(
      Object.fromEntries(
        await agency.agencyBudgetUsage(
          alice.workspaceId,
          new Date(Date.now() + 60_000)
        )
      )
    ).toEqual({ send: 0, calendar: 0, call: 0, submit: 0, other: 0 });

    const recent = await agency.listRecentAgencyActions(alice.workspaceId, 10);
    expect(recent.map((row) => row.status).toSorted()).toEqual([
      "done",
      "failed",
      "planned",
      "planned",
      "undone",
    ]);
    expect(
      await agency.listRecentAgencyActions(alice.workspaceId, 2)
    ).toHaveLength(2);
  });

  it("finds a recorded action by its hash in its own workspace, whatever its status, and keeps the undo it settled with", async () => {
    const { agency } = await openDatabase();

    const created = startedId(
      await agency.beginAgencyAction(plan("calendar-undo", "calendar"))
    );
    expect(
      await agency.agencyActionRecorded(alice.workspaceId, "calendar-undo")
    ).toBe(true);
    expect(
      await agency.agencyActionRecorded(bob.workspaceId, "calendar-undo")
    ).toBe(false);

    const undo = {
      input: { calendarId: "primary", eventId: "e1" },
      tool: "calendar-delete-event",
    };
    expect(await agency.finishAgencyAction(created, "done", undo)).toBe(true);
    const [row] = await agency.listRecentAgencyActions(alice.workspaceId, 1);
    expect(row?.undo).toEqual(undo);

    // A failed action is recorded too: its outcome may be unknown, so it is not retried.
    const failed = startedId(
      await agency.beginAgencyAction(plan("send-failed"))
    );
    expect(await agency.finishAgencyAction(failed, "failed")).toBe(true);
    expect(
      await agency.agencyActionRecorded(alice.workspaceId, "send-failed")
    ).toBe(true);
    expect(await agency.beginAgencyAction(plan("send-failed"))).toEqual({
      kind: "duplicate",
    });
    expect(
      await agency.agencyActionRecorded(alice.workspaceId, "never-taken")
    ).toBe(false);
  });

  it("refuses an action class or status the schema does not know", async () => {
    const { db } = await openDatabase();

    expect(
      await refusal(
        db.execute(sql`
          INSERT INTO agency_actions ("workspace_id", "tool", "action_class", "input_hash", "summary")
          VALUES (${alice.workspaceId}, 'send_message', 'bogus', 'h1', 'x')
        `)
      )
    ).toContain("agency_actions_action_class_check");
    expect(
      await refusal(
        db.execute(sql`
          INSERT INTO agency_actions ("workspace_id", "tool", "action_class", "input_hash", "summary", "status")
          VALUES (${alice.workspaceId}, 'send_message', 'send', 'h2', 'x', 'stuck')
        `)
      )
    ).toContain("agency_actions_status_check");
  });

  it("accepts agent_mail as a proactive signal source", async () => {
    const { proactive } = await openDatabase();
    await proactive.recordProactiveTarget(alice, telegram, now);
    const [watch] = await proactive.claimDueProactiveWatches({
      leaseForMs: 15 * 60_000,
      limit: 10,
      now,
    });
    if (!watch) throw new Error("Expected a due watch.");

    const signal = {
      dedupeKey: "agent-mail:msg-1",
      itemId: "msg-1",
      source: "agent_mail" as const,
      threadId: null,
    };
    const queued = await proactive.queueProactiveRun({
      maxRunsPerDay: 12,
      jobId: watch.jobId,
      mailCheckedAt: now,
      now,
      signals: [signal],
      workspaceId: alice.workspaceId,
    });
    if (queued.status !== "queued") throw new Error("Expected a queued run.");
    expect(await proactive.listProactiveRunSignals(queued.runId)).toEqual([
      signal,
    ]);
  });
});

/** Why the database refused a write, or undefined when it took it. */
async function refusal(write: Promise<unknown>) {
  try {
    await write;
  } catch (error) {
    // Drizzle wraps the database's own error as the cause.
    return error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : String(error);
  }
  return undefined;
}

// Every case starts from a clone of one migrated database: replaying all
// migrations per case is slow enough to starve the rest of the suite.
async function migrateOnce() {
  const client = new PGlite();
  const migrations = (await readdir(new URL("../migrations", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  for (const migration of migrations) {
    await applyMigration(client, migration);
  }
  const dump = await client.dumpDataDir("none");
  await client.close();
  return dump;
}

async function openDatabase() {
  migrated ??= migrateOnce();
  const client = new PGlite({ loadDataDir: await migrated });
  databases.push(client);
  const pgliteDatabase = drizzle(client, { schema });
  await pgliteDatabase
    .insert(schema.workspaces)
    .values([{ id: alice.workspaceId }, { id: bob.workspaceId }]);
  // Modules are reset between cases, so the services must see this copy.
  const Database = await import("@db");
  // SAFETY: PGlite implements the query-builder surface exercised by these services while retaining the shared Drizzle schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The focused test swaps only the database driver.
  vi.spyOn(Database, "db", "get").mockReturnValue(pgliteDatabase as never);
  return {
    db: pgliteDatabase,
    agency: await import("@db/services/agency"),
    proactive: await import("@db/services/proactive"),
  };
}

async function applyMigration(database: PGlite, filename: string) {
  const source = await readFile(
    new URL(`../migrations/${filename}`, import.meta.url),
    "utf8"
  );
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await database.exec(statement);
  }
}

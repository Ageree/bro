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
  const log = await import("@db/services/turn-log");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  await pgliteDatabase.insert(schema.user).values([
    {
      createdAt: new Date("2026-10-12T05:00:00.000Z"),
      email: "alice@example.com",
      id: "alice",
      name: "Алиса",
      phoneNumber: "+79990001122",
    },
    {
      createdAt: new Date("2026-09-01T05:00:00.000Z"),
      email: "bob@example.com",
      id: "bob",
      name: "",
    },
  ]);
  return { database: pgliteDatabase, log };
}

const at = (iso: string) => new Date(`2026-10-12T${iso}.000Z`);

function turn(
  overrides: Partial<{
    kind: "background" | "browser-report" | "person" | "task";
    sessionId: string;
    startedAt: Date;
    turnId: string;
    workspaceId: string;
  }> = {}
) {
  return {
    channel: "telegram",
    kind: "person" as const,
    runId: null,
    sessionId: "tg",
    startedAt: at("07:00:00"),
    turnId: "turn_1",
    userId: alice.userId,
    workspaceId: alice.workspaceId,
    ...overrides,
  };
}

// Each case migrates a fresh PGlite, which takes seconds on a busy machine.
describe("turn log", { timeout: 30_000 }, () => {
  it("records a turn's steps, tools, end and its steps' cost", async () => {
    const { database, log } = await logDatabase();
    const ref = { sessionId: "tg", turnId: "turn_1" };

    await log.recordTurnStart(turn());
    // A retried step emits the turn's start again, a little later.
    await log.recordTurnStart(turn({ startedAt: at("07:00:02") }));
    await log.recordTurnStep(ref, 0);
    await log.recordTurnTools(ref, ["send_message", "web_search"]);
    await log.recordTurnStep(ref, 1);
    await log.recordTurnStep(ref, 0);
    await log.recordTurnTools(ref, ["web_search", "send_message", "yandex"]);
    await database.insert(schema.usageCosts).values([
      {
        costRub: 0.25,
        idempotencyKey: "step:tg:turn_1:0",
        occurredAt: at("07:00:03"),
        source: "chat",
        workspaceId: alice.workspaceId,
      },
      {
        costRub: 0.5,
        idempotencyKey: "step:tg:turn_1:1",
        occurredAt: at("07:00:09"),
        source: "chat",
        workspaceId: alice.workspaceId,
      },
      // Another turn's step, and the same id's step of an earlier turn.
      {
        costRub: 7,
        idempotencyKey: "step:tg:turn_10:0",
        occurredAt: at("07:00:05"),
        source: "chat",
        workspaceId: alice.workspaceId,
      },
      {
        costRub: 9,
        idempotencyKey: "step:tg:turn_1:5",
        occurredAt: at("06:00:00"),
        source: "chat",
        workspaceId: alice.workspaceId,
      },
    ]);

    const ended = await log.recordTurnEnd(ref, {
      endedAt: at("07:00:12"),
      outcome: "completed",
    });

    expect(ended).toMatchObject({
      costRub: 0.75,
      durationMs: 12_000,
      outcome: "completed",
      steps: 2,
      tools: ["send_message", "web_search", "yandex"],
    });
    expect(await database.select().from(schema.turnLog)).toHaveLength(1);
    // A second end finds no open turn.
    expect(
      await log.recordTurnEnd(ref, {
        endedAt: at("07:00:13"),
        outcome: "failed",
      })
    ).toBeUndefined();
  });

  it("closes an open turn of the same id from long before as lost", async () => {
    const { database, log } = await logDatabase();

    await log.recordTurnStart(turn({ turnId: "turn_0" }));
    await log.recordTurnStart(
      turn({ startedAt: at("15:00:00"), turnId: "turn_0" })
    );

    const rows = await database
      .select()
      .from(schema.turnLog)
      .orderBy(schema.turnLog.startedAt);
    expect(rows.map(({ outcome }) => outcome)).toEqual(["lost", "running"]);
  });

  it("keeps a transcript line once and reads the turn's own lines", async () => {
    const { log } = await logDatabase();
    await log.recordTurnStart(turn());
    const line = {
      createdAt: at("07:00:01"),
      eventId: "event-1",
      part: "",
      role: "person" as const,
      sessionId: "tg",
      text: "Найди билеты в Казань",
      toolName: null,
      turnId: "turn_1",
      workspaceId: alice.workspaceId,
    };
    await log.appendTurnEntries([line]);
    await log.appendTurnEntries([line, { ...line, eventId: "e-2", text: "" }]);
    await log.appendTurnEntries([
      {
        ...line,
        createdAt: at("07:00:05"),
        eventId: "event-2",
        part: "call-1",
        role: "bro",
        text: "Ищу",
        toolName: "send_message",
      },
      // The same turn id of an earlier turn of the session.
      { ...line, createdAt: at("06:00:00"), eventId: "event-0", text: "old" },
    ]);
    const ended = await log.recordTurnEnd(
      { sessionId: "tg", turnId: "turn_1" },
      { endedAt: at("07:00:10"), outcome: "completed" }
    );

    const transcript = await log.readTurnTranscript(ended?.id ?? "");
    expect(transcript?.entries.map(({ role, text }) => [role, text])).toEqual([
      ["person", "Найди билеты в Казань"],
      ["bro", "Ищу"],
    ]);
  });

  it("lists people with their last turn, failures and cost, and one's turns", async () => {
    const { database, log } = await logDatabase();
    await log.recordTurnStart(turn());
    await log.recordTurnEnd(
      { sessionId: "tg", turnId: "turn_1" },
      { endedAt: at("07:00:05"), errorCode: "X", outcome: "failed" }
    );
    await log.recordTurnStart(
      turn({
        sessionId: "bob",
        startedAt: at("08:00:00"),
        workspaceId: bob.workspaceId,
      })
    );
    await database.insert(schema.usageCosts).values({
      costRub: 3,
      idempotencyKey: "browser-run:1",
      occurredAt: at("07:30:00"),
      source: "browser-run",
      workspaceId: alice.workspaceId,
    });

    const people = await log.listOwnerUsers({
      from: at("00:00:00"),
      to: at("23:00:00"),
    });
    expect(
      people.map(({ costRub, failed, label, turns }) => ({
        costRub,
        failed,
        label,
        turns,
      }))
    ).toEqual([
      { costRub: 0, failed: 0, label: "bob@example.com", turns: 1 },
      { costRub: 3, failed: 1, label: "Алиса (+79990001122)", turns: 1 },
    ]);
    const turns = await log.listWorkspaceTurns(alice.workspaceId, {
      from: at("00:00:00"),
      to: at("23:00:00"),
    });
    expect(turns.map(({ errorCode }) => errorCode)).toEqual(["X"]);
  });

  it("summarizes the day for the owner", async () => {
    const { database, log } = await logDatabase();
    await log.recordTurnStart(turn());
    await log.recordTurnEnd(
      { sessionId: "tg", turnId: "turn_1" },
      {
        endedAt: at("07:00:05"),
        errorCode: "MODEL_CALL_FAILED 402",
        outcome: "failed",
      }
    );
    await log.recordTurnStart(turn({ kind: "background", turnId: "turn_2" }));
    await database.insert(schema.usageCosts).values({
      costRub: 1.5,
      idempotencyKey: "step:tg:turn_1:0",
      occurredAt: at("07:00:01"),
      source: "chat",
      workspaceId: alice.workspaceId,
    });

    const day = await log.summarizeOwnerDay({
      from: at("00:00:00"),
      to: at("23:00:00"),
    });
    expect(day).toEqual({
      activePeople: 1,
      costs: [
        {
          costRub: 1.5,
          label: "Алиса (+79990001122)",
          workspaceId: alice.workspaceId,
        },
      ],
      failures: [{ errorCode: "MODEL_CALL_FAILED 402", turns: 1 }],
      signedUp: ["Алиса (+79990001122)"],
      turnsByKind: { background: 1, person: 1 },
    });
  });

  it("forgets transcripts after the retention, turns after 180 days", async () => {
    const { database, log } = await logDatabase();
    const now = at("12:00:00");
    const daysAgo = (days: number) =>
      new Date(now.getTime() - days * 24 * 60 * 60_000);
    await log.recordTurnStart(turn({ startedAt: daysAgo(200), turnId: "a" }));
    await log.recordTurnStart(turn({ startedAt: daysAgo(2), turnId: "b" }));
    await log.recordTurnStart(turn({ startedAt: daysAgo(0.1), turnId: "c" }));
    const entry = {
      eventId: "e",
      part: "",
      role: "person" as const,
      sessionId: "tg",
      text: "текст",
      toolName: null,
      turnId: "b",
      workspaceId: alice.workspaceId,
    };
    await log.appendTurnEntries([
      { ...entry, createdAt: daysAgo(31) },
      { ...entry, createdAt: daysAgo(29), eventId: "f" },
    ]);

    await log.expireTurnLog(30, now);

    const turns = await database
      .select()
      .from(schema.turnLog)
      .orderBy(schema.turnLog.startedAt);
    expect(turns.map(({ outcome, turnId }) => [turnId, outcome])).toEqual([
      ["b", "lost"],
      ["c", "running"],
    ]);
    const entries = await database.select().from(schema.turnLogEntries);
    expect(entries.map(({ eventId }) => eventId)).toEqual(["f"]);
  });

  it("counts the people whose turns failed with a code since a moment", async () => {
    const { log } = await logDatabase();
    const fail = async (
      sessionId: string,
      workspaceId: string,
      startedAt: Date,
      errorCode = "MODEL_CALL_FAILED 402"
    ) => {
      await log.recordTurnStart(turn({ sessionId, startedAt, workspaceId }));
      await log.recordTurnEnd(
        { sessionId, turnId: "turn_1" },
        { endedAt: startedAt, errorCode, outcome: "failed" }
      );
    };
    await fail("a1", alice.workspaceId, at("07:10:00"));
    await fail("a2", alice.workspaceId, at("07:20:00"));
    await fail("b1", bob.workspaceId, at("07:30:00"));
    await fail("b2", bob.workspaceId, at("05:00:00"));
    await fail("b3", bob.workspaceId, at("07:40:00"), "MODEL_CALL_FAILED 400");

    await expect(
      log.countFailedPeople("MODEL_CALL_FAILED 402", at("07:00:00"))
    ).resolves.toBe(2);
    await expect(
      log.countFailedPeople("MODEL_CALL_FAILED 402", at("07:25:00"))
    ).resolves.toBe(1);
  });

  it("lists each workspace's channels and finds an account's email", async () => {
    const { log } = await logDatabase();
    await log.recordTurnStart(turn({ sessionId: "a" }));
    await log.recordTurnStart(turn({ sessionId: "b" }));
    await log.recordTurnStart({
      ...turn({ sessionId: "c", workspaceId: bob.workspaceId }),
      channel: "web",
    });

    const channels = await log.workspaceChannels([
      alice.workspaceId,
      bob.workspaceId,
    ]);
    expect(channels.get(alice.workspaceId)).toEqual(["telegram"]);
    expect(channels.get(bob.workspaceId)).toEqual(["web"]);
    await expect(log.workspaceChannels([])).resolves.toEqual(new Map());
    await expect(log.readAccountEmail(alice.userId)).resolves.toBe(
      "alice@example.com"
    );
    await expect(log.readAccountEmail("alice")).resolves.toBeUndefined();
  });
});

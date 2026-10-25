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

async function tipsDatabase() {
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
  const tips = await import("@db/services/capability-tips");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return { database: pgliteDatabase, tips };
}

const hourMs = 60 * 60_000;
const start = new Date("2026-10-25T09:00:00.000Z");
const later = (hours: number) => new Date(start.getTime() + hours * hourMs);
const policy = {
  limit: 2,
  maxOffers: 2,
  restMs: 72 * hourMs,
  spacingMs: 6 * hourMs,
};

function turn(
  workspaceId: string,
  turnId: string,
  kind: "background" | "browser-report" | "person",
  tools: string[]
) {
  return {
    channel: "telegram",
    kind,
    sessionId: `session:${workspaceId}`,
    startedAt: start,
    tools,
    turnId,
    workspaceId,
  };
}

// Each case migrates a fresh PGlite, which takes seconds on a busy machine.
describe("capability tips", { timeout: 30_000 }, () => {
  it("reads what the person's own turns tried, not Bro's own", async () => {
    const { database, tips } = await tipsDatabase();
    await database.insert(schema.turnLog).values([
      turn(alice.workspaceId, "turn_0", "person", ["send_message"]),
      turn(alice.workspaceId, "turn_1", "person", [
        "phone-call",
        "send_message",
      ]),
      turn(alice.workspaceId, "turn_2", "browser-report", ["browser_task"]),
      // A mail check's worker reads the calendar on its own.
      turn(alice.workspaceId, "turn_3", "background", ["calendar-list-events"]),
      turn(bob.workspaceId, "turn_0", "person", ["generate_image"]),
    ]);

    const use = await tips.readCapabilityHistory(alice.workspaceId);
    expect(use.personTurns).toBe(2);
    expect(use.tools.toSorted()).toEqual([
      "browser_task",
      "phone-call",
      "send_message",
    ]);
    expect(use.googleConnected).toBe(false);
    expect(use.lastTipAt).toBeNull();
  });

  it("spaces tips out, rests an offered capability and stops after a few offers", async () => {
    const { tips } = await tipsDatabase();
    const claim = (candidates: string[], at: Date) =>
      tips.claimCapabilityTip(alice.workspaceId, candidates, policy, at);

    expect(await claim(["call", "reminders", "files"], start)).toEqual([
      "call",
      "reminders",
    ]);
    expect(
      (await tips.readCapabilityHistory(alice.workspaceId)).lastTipAt
    ).toEqual(start);
    // Too soon after the last tip, whatever it named.
    expect(await claim(["files"], later(2))).toEqual([]);
    // Another workspace has its own.
    expect(
      await tips.claimCapabilityTip(bob.workspaceId, ["call"], policy, later(2))
    ).toEqual(["call"]);
    // Spaced out, but the two offered still rest.
    expect(await claim(["call", "reminders", "files"], later(7))).toEqual([
      "files",
    ]);
    // Rested: offered a second time.
    expect(await claim(["call", "reminders"], later(80))).toEqual([
      "call",
      "reminders",
    ]);
    // Offered twice: never again.
    expect(await claim(["call", "reminders"], later(200))).toEqual([]);
  });
});

import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import flightBooked from "../../docs/cards/examples/flight-booked.json";
import { cardSchema } from "../../shared/cards/schema";
import * as schema from "../schema";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const start = new Date("2026-10-23T10:00:00Z");
const days = (count: number) => count * 86_400_000;
const card = cardSchema.parse(flightBooked);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function cards() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const database = drizzle(client, { schema });
  const [Database, scope, service] = await Promise.all([
    import("@db"),
    import("@db/services/scope"),
    import("@db/services/cards"),
  ]);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
  await scope.ensureScope(alice);
  return { database, service };
}

describe("cards", () => {
  it("opens a card by its link, and keeps it for thirty days", async () => {
    const { service } = await cards();
    const id = await service.createCard(alice, card, start);

    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await service.readCardByLink(id, start)).toEqual(card);
    expect(
      await service.readCardByLink(id, new Date(start.getTime() + days(30) - 1))
    ).toEqual(card);
  });

  it("makes an expired card and a card that never was look the same", async () => {
    const { service } = await cards();
    const id = await service.createCard(alice, card, start);

    const expired = await service.readCardByLink(
      id,
      new Date(start.getTime() + days(30))
    );
    const missing = await service.readCardByLink("A".repeat(43), start);
    const malformed = await service.readCardByLink("not-a-link", start);

    expect(expired).toBeUndefined();
    expect(missing).toBeUndefined();
    expect(malformed).toBeUndefined();
  });

  it("treats a stored payload the schema no longer accepts as missing", async () => {
    const { database, service } = await cards();
    const id = await service.createCard(alice, card, start);
    await database.execute(
      sql`update cards set payload = '{"title": 7}'::jsonb`
    );

    expect(await service.readCardByLink(id, start)).toBeUndefined();
  });

  it("drops the cards that expired when a new one is kept", async () => {
    const { database, service } = await cards();
    const old = await service.createCard(alice, card, start);
    const later = new Date(start.getTime() + days(31));
    const fresh = await service.createCard(alice, card, later);

    const rows = await database
      .select({ id: schema.cards.id })
      .from(schema.cards);
    expect(rows.map((row) => row.id)).toEqual([fresh]);
    expect(await service.readCardByLink(old, later)).toBeUndefined();
  });

  it("goes with the person's membership", async () => {
    const { database, service } = await cards();
    await service.createCard(alice, card, start);
    await database
      .delete(schema.workspaceMemberships)
      .where(eq(schema.workspaceMemberships.userId, alice.userId));

    expect(await database.select().from(schema.cards)).toEqual([]);
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

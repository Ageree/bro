import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import flightBooked from "../../docs/cards/examples/flight-booked.json";
import { cardPhotoObject } from "../../shared/cards/photos";
import { cardSchema } from "../../shared/cards/schema";
import * as schema from "../schema";

const storage = vi.hoisted(() => ({
  delete: vi.fn<(pathname: string) => Promise<void>>(),
}));

vi.mock("@shared/object-storage/artifacts", () => ({
  deleteArtifactObject: storage.delete,
}));

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const start = new Date("2026-10-23T10:00:00Z");
const days = (count: number) => count * 86_400_000;
const card = cardSchema.parse(flightBooked);

function withPhotos(id: string, ...numbers: number[]) {
  return cardSchema.parse({
    blocks: numbers.map((number) => ({
      alt: "Кухня",
      type: "image",
      url: `/api/cards/${id}/photos/${String(number)}`,
    })),
    title: "Квартира",
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  storage.delete.mockReset();
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
  const keep = async (now: Date, kept = card) => {
    const id = service.newCardId();
    await service.createCard(alice, id, kept, now);
    return id;
  };
  return { database, keep, service };
}

describe("cards", () => {
  it("opens a card by its link, and keeps it for thirty days", async () => {
    const { keep, service } = await cards();
    const id = await keep(start);

    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await service.readCardByLink(id, start)).toEqual(card);
    expect(
      await service.readCardByLink(id, new Date(start.getTime() + days(30) - 1))
    ).toEqual(card);
  });

  it("makes an expired card and a card that never was look the same", async () => {
    const { keep, service } = await cards();
    const id = await keep(start);

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
    const { database, keep, service } = await cards();
    const id = await keep(start);
    await database.execute(
      sql`update cards set payload = '{"title": 7}'::jsonb`
    );

    expect(await service.readCardByLink(id, start)).toBeUndefined();
  });

  it("drops the cards that expired when a new one is kept", async () => {
    const { database, keep, service } = await cards();
    const old = await keep(start);
    const later = new Date(start.getTime() + days(31));
    const fresh = await keep(later);

    const rows = await database
      .select({ id: schema.cards.id })
      .from(schema.cards);
    expect(rows.map((row) => row.id)).toEqual([fresh]);
    expect(await service.readCardByLink(old, later)).toBeUndefined();
  });

  it("takes the copies of an expired card's photos with it, and only that card's", async () => {
    const { database, keep, service } = await cards();
    const old = service.newCardId();
    const later = new Date(start.getTime() + days(31));
    await service.createCard(alice, old, withPhotos(old, 0, 1, 2), start);
    const kept = service.newCardId();
    await service.createCard(
      alice,
      kept,
      withPhotos(kept, 0),
      new Date(start.getTime() + days(2))
    );
    storage.delete.mockResolvedValue();

    const fresh = await keep(later);

    expect(storage.delete.mock.calls.map(([pathname]) => pathname)).toEqual(
      [0, 1, 2].map((number) => cardPhotoObject(old, number))
    );
    const rows = await database
      .select({ id: schema.cards.id })
      .from(schema.cards);
    expect(rows.map((row) => row.id).toSorted()).toEqual(
      [fresh, kept].toSorted()
    );
  });

  it("keeps an expired card while the store keeps its copies, for the next card to try again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { database, keep, service } = await cards();
    const old = service.newCardId();
    await service.createCard(alice, old, withPhotos(old, 0), start);
    const later = new Date(start.getTime() + days(31));
    storage.delete.mockRejectedValueOnce(new Error("Object Storage 503"));

    await keep(later);

    const ids = async () =>
      (await database.select({ id: schema.cards.id }).from(schema.cards)).map(
        (row) => row.id
      );
    expect(await ids()).toContain(old);
    expect(await service.readCardByLink(old, later)).toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(old);

    storage.delete.mockResolvedValue();
    await keep(later);
    expect(await ids()).not.toContain(old);
  });

  it("goes with the person's membership", async () => {
    const { database, keep } = await cards();
    await keep(start);
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

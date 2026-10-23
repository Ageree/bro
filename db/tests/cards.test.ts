import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import flightBooked from "../../docs/cards/examples/flight-booked.json";
import hotelChoice from "../../docs/cards/examples/hotel-choice.json";
import { cardSchema } from "../../shared/cards/schema";
import * as schema from "../schema";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const start = new Date("2026-10-23T10:00:00Z");
const days = (count: number) => count * 86_400_000;
const minutes = (count: number) => count * 60_000;
const card = cardSchema.parse(flightBooked);
const hotel = cardSchema.parse(hotelChoice);
const chat = {
  conversationChannel: "telegram" as const,
  conversationId: "4242::",
};

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
    const { id, ref } = await service.createCard(alice, card, chat, start);

    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(ref).toMatch(/^[a-z2-9]{8}$/u);
    expect(await service.readCardByLink(id, start)).toMatchObject({
      card,
      conversationId: "4242::",
      revision: 1,
      updatedAt: null,
      ...alice,
    });
    expect(
      (
        await service.readCardByLink(
          id,
          new Date(start.getTime() + days(30) - 1)
        )
      )?.card
    ).toEqual(card);
  });

  it("makes an expired card and a card that never was look the same", async () => {
    const { service } = await cards();
    const { id } = await service.createCard(alice, card, chat, start);

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
    const { id } = await service.createCard(alice, card, chat, start);
    await database.execute(
      sql`update cards set payload = '{"title": 7}'::jsonb`
    );

    expect(await service.readCardByLink(id, start)).toBeUndefined();
  });

  it("drops the cards that expired when a new one is kept", async () => {
    const { database, service } = await cards();
    const old = await service.createCard(alice, card, chat, start);
    const later = new Date(start.getTime() + days(31));
    const fresh = await service.createCard(alice, card, chat, later);

    const rows = await database
      .select({ id: schema.cards.id })
      .from(schema.cards);
    expect(rows.map((row) => row.id)).toEqual([fresh.id]);
    expect(await service.readCardByLink(old.id, later)).toBeUndefined();
  });

  it("goes with the person's membership", async () => {
    const { database, service } = await cards();
    await service.createCard(alice, card, chat, start);
    await database
      .delete(schema.workspaceMemberships)
      .where(eq(schema.workspaceMemberships.userId, alice.userId));

    expect(await database.select().from(schema.cards)).toEqual([]);
  });
});

describe("a card's answers", () => {
  const answer = {
    action: "continue",
    values: { extras: ["parking"], hotel: "nevsky_dvor" },
  };
  const response = {
    answer,
    summary: "Отель: Невский Двор\nНажал: «Продолжить с выбором»",
    telegramUserId: "4242",
  };

  async function answered() {
    const { database, service } = await cards();
    const { id, ref } = await service.createCard(alice, hotel, chat, start);
    const found = await service.readCardByLink(id, start);
    if (!found) throw new Error("Expected the card.");
    return { database, found, ref, service };
  }

  it("keeps one answer per revision: the same again is a repeat, another is turned away", async () => {
    const { database, found, service } = await answered();

    expect(await service.saveCardResponse(found, response, start)).toEqual({
      answer,
      outcome: "received",
      state: "received",
    });
    expect(
      await service.saveCardResponse(
        found,
        {
          ...response,
          answer: {
            action: "continue",
            values: { hotel: "nevsky_dvor", extras: ["parking"] },
          },
        },
        start
      )
    ).toMatchObject({ outcome: "repeat" });
    expect(
      await service.saveCardResponse(
        found,
        {
          ...response,
          answer: { action: "more", values: {} },
        },
        start
      )
    ).toEqual({ answer, outcome: "answered", state: "received" });
    expect(await database.select().from(schema.cardResponses)).toHaveLength(1);
    expect(await service.readCardResponse(found.id, 1)).toEqual({
      ...answer,
      state: "received",
    });
  });

  it("gives each waiting answer to one caller, again once its claim ran out, and fails it after the third", async () => {
    const { found, ref, service } = await answered();
    await service.saveCardResponse(found, response, start);

    const [first, second] = await Promise.all([
      service.claimCardResponses(start),
      service.claimCardResponses(start),
    ]);
    expect([...first, ...second]).toEqual([
      expect.objectContaining({
        action: "continue",
        conversationId: "4242::",
        ref,
        revision: 1,
        summary: response.summary,
        ...alice,
      }),
    ]);
    expect(
      await service.claimCardResponses(new Date(start.getTime() + minutes(1)))
    ).toEqual([]);

    const [again] = await service.claimCardResponses(
      new Date(start.getTime() + minutes(3))
    );
    if (!again) throw new Error("Expected the answer again.");
    await service.releaseCardResponse(again.id);
    expect(
      await service.claimCardResponses(new Date(start.getTime() + minutes(4)))
    ).toHaveLength(1);
    await service.releaseCardResponse(again.id);

    expect(
      await service.claimCardResponses(new Date(start.getTime() + minutes(5)))
    ).toEqual([]);
    expect(await service.readCardResponse(found.id, 1)).toMatchObject({
      state: "failed",
    });
  });

  it("never sends a delivered answer again, and gives up on one a day old", async () => {
    const { database, found, service } = await answered();
    await service.saveCardResponse(found, response, start);
    const [claimed] = await service.claimCardResponses(start);
    if (!claimed) throw new Error("Expected the answer.");
    await service.markCardResponseDelivered(claimed.id, start);
    await service.releaseCardResponse(claimed.id);

    expect(
      await service.claimCardResponses(new Date(start.getTime() + minutes(10)))
    ).toEqual([]);
    expect(await service.readCardResponse(found.id, 1)).toMatchObject({
      state: "delivered",
    });

    await database.delete(schema.cardResponses);
    await service.saveCardResponse(found, response, start);
    expect(
      await service.claimCardResponses(new Date(start.getTime() + days(1) + 1))
    ).toEqual([]);
    expect(await service.readCardResponse(found.id, 1)).toMatchObject({
      state: "failed",
    });
  });

  it("updates the person's card in its own chat only, one revision up, and takes a new answer to it", async () => {
    const { found, ref, service } = await answered();
    await service.saveCardResponse(found, response, start);
    const later = new Date(start.getTime() + minutes(5));
    const changed = { ...hotel, subtitle: "Ещё три варианта" };

    expect(
      await service.updateCard(
        { ...alice, userId: "bob" },
        { conversationId: "4242::", ref },
        changed,
        later
      )
    ).toBeUndefined();
    expect(
      await service.updateCard(
        alice,
        { conversationId: "9999::", ref },
        changed,
        later
      )
    ).toBeUndefined();
    expect(
      await service.updateCard(
        alice,
        { conversationId: "4242::", ref },
        changed,
        later
      )
    ).toEqual({ id: found.id, revision: 2 });

    const now = await service.readCardByLink(found.id, later);
    expect(now).toMatchObject({ card: changed, revision: 2, updatedAt: later });
    if (!now) throw new Error("Expected the card.");
    expect(await service.saveCardResponse(now, response, later)).toMatchObject({
      outcome: "received",
    });
    expect(await service.countCardResponses(alice.workspaceId, start)).toBe(2);
    expect(await service.countCardResponses(alice.workspaceId, later)).toBe(1);
  });

  it("go with their card", async () => {
    const { database, found, service } = await answered();
    await service.saveCardResponse(found, response, start);
    await service.createCard(
      alice,
      hotel,
      chat,
      new Date(start.getTime() + days(31))
    );

    expect(await database.select().from(schema.cardResponses)).toEqual([]);
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

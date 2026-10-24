import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import flightBooked from "../../docs/cards/examples/flight-booked.json";
import { cardPhotoObject } from "../../shared/cards/photos";
import hotelChoice from "../../docs/cards/examples/hotel-choice.json";
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
const minutes = (count: number) => count * 60_000;
const card = cardSchema.parse(flightBooked);
const hotel = cardSchema.parse(hotelChoice);
const chat = {
  conversationChannel: "telegram" as const,
  conversationId: "4242::",
};
const press = (action: string, values: Record<string, string> = {}) => ({
  answer: { action, values },
  item: undefined,
  summary: `Нажал: «${action}»`,
  telegramUserId: "4242",
});

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
  const keep = async (now: Date) =>
    (await service.createCard(alice, card, chat, now)).id;
  return { database, keep, service };
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

  it("takes the copies of an expired card's photos with it, and only that card's", async () => {
    const { database, keep, service } = await cards();
    const old = service.newCardId();
    const later = new Date(start.getTime() + days(31));
    await service.createCard(alice, withPhotos(old, 0, 1, 2), chat, start, old);
    const kept = service.newCardId();
    await service.createCard(
      alice,
      withPhotos(kept, 0),
      chat,
      new Date(start.getTime() + days(2)),
      kept
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
    await service.createCard(alice, withPhotos(old, 0), chat, start, old);
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

  it("removes an updated card's old photo copies once the new card is kept", async () => {
    const { service } = await cards();
    const old = service.newCardId();
    const { ref } = await service.createCard(
      alice,
      withPhotos(old, 0, 1),
      chat,
      start,
      old
    );
    storage.delete.mockResolvedValue();

    const updated = await service.updateCard(
      alice,
      { conversationId: chat.conversationId, ref },
      ({ card: current, id }) => {
        expect(current).toEqual(withPhotos(old, 0, 1));
        return Promise.resolve({ card: withPhotos(id, 2, 3) });
      },
      start
    );

    expect(updated).toMatchObject({ id: old, revision: 2 });
    expect(storage.delete.mock.calls.map(([pathname]) => pathname)).toEqual([
      cardPhotoObject(old, 0),
      cardPhotoObject(old, 1),
    ]);
    expect(await service.readCardByLink(old, start)).toMatchObject({
      card: withPhotos(old, 2, 3),
      revision: 2,
    });
  });

  it("removes the new copies instead when the update could not be kept", async () => {
    const { database, service } = await cards();
    const old = service.newCardId();
    const { ref } = await service.createCard(
      alice,
      withPhotos(old, 0),
      chat,
      start,
      old
    );
    await database.execute(sql`
      create function refuse_card_update() returns trigger language plpgsql as $$
      begin raise exception 'the card is not updated'; end $$
    `);
    await database.execute(sql`
      create trigger refuse_card_update before update on cards
      for each row execute function refuse_card_update()
    `);
    storage.delete.mockResolvedValue();

    await expect(
      service.updateCard(
        alice,
        { conversationId: chat.conversationId, ref },
        ({ id }) => Promise.resolve({ card: withPhotos(id, 1, 2) }),
        start
      )
    ).rejects.toThrow("Failed query");

    expect(storage.delete.mock.calls.map(([pathname]) => pathname)).toEqual([
      cardPhotoObject(old, 1),
      cardPhotoObject(old, 2),
    ]);
    expect(await service.readCardByLink(old, start)).toMatchObject({
      card: withPhotos(old, 0),
      revision: 1,
    });
  });

  it("leaves a card as it was when the change gives none", async () => {
    const { service } = await cards();
    const old = service.newCardId();
    const { ref } = await service.createCard(
      alice,
      withPhotos(old, 0),
      chat,
      start,
      old
    );

    expect(
      await service.updateCard(
        alice,
        { conversationId: chat.conversationId, ref },
        () => Promise.resolve({ card: undefined }),
        start
      )
    ).toMatchObject({ id: old, revision: undefined });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(await service.readCardByLink(old, start)).toMatchObject({
      revision: 1,
    });
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
        claimedAt: start,
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
    await service.releaseCardResponse(again.id, again.claimedAt);
    const third = await service.claimCardResponses(
      new Date(start.getTime() + minutes(4))
    );
    expect(third).toHaveLength(1);
    if (!third[0]) throw new Error("Expected the third claim.");
    await service.releaseCardResponse(third[0].id, third[0].claimedAt);

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
    await service.markCardResponseDelivered(
      claimed.id,
      claimed.claimedAt,
      start
    );
    await service.releaseCardResponse(claimed.id, claimed.claimedAt);

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

  it.each(["release", "delivered", "fail"] as const)(
    "ignores a late %s from an expired claim without changing its newer lease",
    async (outcome) => {
      const { database, found, service } = await answered();
      await service.saveCardResponse(found, response, start);
      const [first] = await service.claimCardResponses(start);
      const claimedAt = new Date(start.getTime() + minutes(3));
      const [current] = await service.claimCardResponses(claimedAt);
      if (!first || !current) throw new Error("Expected both claims.");
      const before = await database.select().from(schema.cardResponses);

      if (outcome === "release")
        await service.releaseCardResponse(first.id, start);
      else if (outcome === "delivered")
        await service.markCardResponseDelivered(first.id, start, claimedAt);
      else await service.failCardResponse(first.id, start);

      expect(await database.select().from(schema.cardResponses)).toEqual(
        before
      );
      expect(
        await service.claimCardResponses(new Date(claimedAt.getTime() + 1))
      ).toEqual([]);

      if (outcome === "release") {
        await service.releaseCardResponse(current.id, claimedAt);
      } else if (outcome === "delivered") {
        await service.markCardResponseDelivered(
          current.id,
          claimedAt,
          claimedAt
        );
      } else {
        await service.failCardResponse(current.id, claimedAt);
      }
      expect(await service.readCardResponse(found.id, 1)).toMatchObject({
        state:
          outcome === "delivered"
            ? "delivered"
            : outcome === "fail"
              ? "failed"
              : "received",
      });
      expect(
        await service.claimCardResponses(new Date(claimedAt.getTime() + 1))
      ).toHaveLength(outcome === "release" ? 1 : 0);
    }
  );

  it("updates the person's card in its own chat only, one revision up, and takes a new answer to it", async () => {
    const { found, ref, service } = await answered();
    await service.saveCardResponse(found, response, start);
    const later = new Date(start.getTime() + minutes(5));
    const changed = { ...hotel, subtitle: "Ещё три варианта" };
    const change = () => Promise.resolve({ card: changed });

    expect(
      await service.updateCard(
        { ...alice, userId: "bob" },
        { conversationId: "4242::", ref },
        change,
        later
      )
    ).toBeUndefined();
    expect(
      await service.updateCard(
        alice,
        { conversationId: "9999::", ref },
        change,
        later
      )
    ).toBeUndefined();
    expect(
      await service.updateCard(
        alice,
        { conversationId: "4242::", ref },
        change,
        later
      )
    ).toEqual({
      change: { card: changed },
      id: found.id,
      revision: 2,
      watchedAt: null,
    });

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

describe("a card's intents", () => {
  const answer = {
    answer: { action: "continue", values: { hotel: "nevsky_dvor" } },
    summary: "Отель: Невский Двор\nНажал: «Продолжить с выбором»",
    telegramUserId: "4242",
  };
  const at = (count: number) => new Date(start.getTime() + minutes(count));

  async function pressed() {
    const { database, service } = await cards();
    const { id, ref } = await service.createCard(alice, hotel, chat, start);
    const found = await service.readCardByLink(id, start);
    if (!found) throw new Error("Expected the card.");
    const rows = () =>
      database
        .select({
          action: schema.cardResponses.action,
          kind: schema.cardResponses.kind,
          state: schema.cardResponses.state,
        })
        .from(schema.cardResponses);
    return { database, found, ref, rows, service };
  }

  it("keeps the person's last word: a waiting intent takes the new press, one Bro took up stays", async () => {
    const { found, rows, service } = await pressed();

    expect(await service.saveCardIntent(found, press("more"), start)).toBe(
      "received"
    );
    expect(await service.saveCardIntent(found, press("more"), at(1))).toBe(
      "repeat"
    );
    expect(
      await service.saveCardIntent(
        found,
        press("refresh", { guests: "3" }),
        at(1)
      )
    ).toBe("replaced");
    expect(await rows()).toEqual([
      { action: "refresh", kind: "intent", state: "received" },
    ]);

    const [taken] = await service.claimCardResponses(at(1));
    expect(taken).toMatchObject({
      action: "refresh",
      item: null,
      kind: "intent",
      values: { guests: "3" },
    });
    expect(await service.saveCardIntent(found, press("more"), at(2))).toBe(
      "received"
    );
    expect((await rows()).map((row) => row.action).toSorted()).toEqual([
      "more",
      "refresh",
    ]);
  });

  it("lets an answer take the place of an intent still waiting, and of no other", async () => {
    const { found, rows, service } = await pressed();
    await service.saveCardIntent(found, press("more"), start);
    await service.claimCardResponses(start);
    await service.saveCardIntent(found, press("refresh"), at(1));

    expect(await service.saveCardResponse(found, answer, at(2))).toMatchObject({
      outcome: "received",
    });
    expect(
      (await rows()).map(({ action, kind }) => `${kind}:${action}`).toSorted()
    ).toEqual(["intent:more", "submit:continue"]);
    expect(await service.readCardResponse(found.id, 1)).toMatchObject({
      action: "continue",
    });
  });

  it.each(["submit", "intent"] as const)(
    "keeps only the final submit when concurrent saves start with %s",
    async (first) => {
      const { found, rows, service } = await pressed();
      expect(
        await service.readCardResponse(found.id, found.revision)
      ).toBeUndefined();
      const submit = () => service.saveCardResponse(found, answer, start);
      const intent = () => service.saveCardIntent(found, press("more"), start);

      await Promise.all(
        first === "submit" ? [submit(), intent()] : [intent(), submit()]
      );

      expect(await rows()).toEqual([
        { action: "continue", kind: "submit", state: "received" },
      ]);
    }
  );

  it("refuses an intent after its revision was submitted, but accepts one after the card updates", async () => {
    const { found, ref, rows, service } = await pressed();
    await service.saveCardResponse(found, answer, start);

    expect(await service.saveCardIntent(found, press("more"), start)).toBe(
      "busy"
    );
    await service.updateCard(
      alice,
      { conversationId: chat.conversationId, ref },
      async () => ({ card: hotel }),
      start
    );
    const updated = await service.readCardByLink(found.id, start);
    if (!updated) throw new Error("Expected the updated card.");
    expect(await service.saveCardIntent(updated, press("more"), start)).toBe(
      "received"
    );
    expect((await rows()).map((row) => row.kind).toSorted()).toEqual([
      "intent",
      "submit",
    ]);
  });

  it("gives a card one turn of its presses at a time", async () => {
    const { found, service } = await pressed();
    await service.saveCardIntent(found, press("more"), start);
    const [first] = await service.claimCardResponses(start);
    if (!first) throw new Error("Expected the intent.");
    await service.saveCardResponse(found, answer, at(1));

    expect(await service.claimCardResponses(at(1))).toEqual([]);
    expect(await service.readCardPress(found.id, at(1))).toMatchObject({
      action: "continue",
      kind: "submit",
      stage: "queued",
    });

    await service.markCardResponseDelivered(first.id, first.claimedAt, at(1));
    expect(await service.claimCardResponses(at(2))).toEqual([]);
    await service.finishCardResponse(first.id, at(3));
    expect(await service.claimCardResponses(at(3))).toMatchObject([
      { action: "continue", kind: "submit" },
    ]);
  });

  it("keeps replacing the latest waiting intent behind a delivered intent's turn", async () => {
    const { found, service } = await pressed();
    await service.saveCardIntent(found, press("more"), start);
    const [first] = await service.claimCardResponses(start);
    if (!first) throw new Error("Expected the first intent.");
    await service.markCardResponseDelivered(first.id, first.claimedAt, start);

    expect(await service.saveCardIntent(found, press("refresh"), at(1))).toBe(
      "received"
    );
    expect(await service.saveCardIntent(found, press("question"), at(2))).toBe(
      "replaced"
    );
    expect(await service.claimCardResponses(at(2))).toEqual([]);

    await service.finishCardResponse(first.id, at(3));
    expect(await service.claimCardResponses(at(3))).toMatchObject([
      { action: "question", kind: "intent" },
    ]);
  });

  it("lets the next press go once a turn's end went unrecorded for five minutes", async () => {
    const { found, service } = await pressed();
    await service.saveCardIntent(found, press("more"), start);
    const [first] = await service.claimCardResponses(start);
    if (!first) throw new Error("Expected the intent.");
    await service.markCardResponseDelivered(first.id, first.claimedAt, start);
    await service.saveCardIntent(found, press("refresh"), at(1));

    expect(await service.claimCardResponses(at(4))).toEqual([]);
    expect(await service.claimCardResponses(at(6))).toMatchObject([
      { action: "refresh" },
    ]);
  });

  it("drops an intent that waited ten minutes", async () => {
    const { found, rows, service } = await pressed();
    await service.saveCardIntent(found, press("more"), start);

    expect(await service.readCardPress(found.id, at(10))).toMatchObject({
      stage: "failed",
    });
    expect(await service.claimCardResponses(at(10))).toEqual([]);
    expect(await rows()).toEqual([
      { action: "more", kind: "intent", state: "failed" },
    ]);
  });

  it("says how the latest press stands, its search included", async () => {
    const { database, found, service } = await pressed();
    expect(await service.readCardPress(found.id, start)).toBeUndefined();
    await service.saveCardIntent(found, press("more"), start);
    expect(await service.readCardPress(found.id, start)).toEqual({
      action: "more",
      item: undefined,
      kind: "intent",
      revision: 1,
      stage: "waiting",
    });
    const [taken] = await service.claimCardResponses(start);
    if (!taken) throw new Error("Expected the intent.");
    await service.markCardResponseDelivered(taken.id, taken.claimedAt, start);
    expect(await service.readCardPress(found.id, at(1))).toMatchObject({
      stage: "working",
    });

    await database.insert(schema.browserRuns).values({
      conversationChannel: "telegram",
      conversationId: chat.conversationId,
      createdByUserId: alice.userId,
      id: "run-1",
      sessionId: "browser-session-1",
      status: "running",
      task: "Найди ещё три отеля",
      workspaceId: alice.workspaceId,
    });
    await service.linkCardResponseRun(taken.id, "run-1");
    await service.finishCardResponse(taken.id, at(1));
    expect(await service.readCardPress(found.id, at(2))).toMatchObject({
      stage: "searching",
    });
    expect(await service.readCardOfRun("run-1", at(2))).toMatchObject({
      id: found.id,
    });
    await service.linkCardResponseRun(taken.id, "run-2");
    expect(await service.readCardOfRun("run-2", at(2))).toBeUndefined();
    await database
      .update(schema.browserRuns)
      .set({ retriedAsRunId: "run-2" })
      .where(eq(schema.browserRuns.id, "run-1"));
    expect(await service.readCardOfRun("run-2", at(2))).toMatchObject({
      id: found.id,
    });

    await database
      .update(schema.browserRuns)
      .set({ reportDeliveredAt: at(5), status: "done" })
      .where(eq(schema.browserRuns.id, "run-1"));
    expect(await service.readCardPress(found.id, at(5))).toMatchObject({
      stage: "done",
    });
  });

  describe("the browser run a card press is waiting for", () => {
    async function linkedPress(status: "done" | "waiting" = "waiting") {
      const current = await pressed();
      const { found, service } = current;
      const runs = await import("@db/services/browser-runs");
      await service.saveCardIntent(found, press("more"), start);
      const [taken] = await service.claimCardResponses(start);
      if (!taken) throw new Error("Expected the card's press.");
      await service.markCardResponseDelivered(taken.id, taken.claimedAt, start);
      await runs.createBrowserRun(alice, {
        ...chat,
        completedAt: at(1),
        id: "run-1",
        sessionId: "browser-session-1",
        status,
        task: "Найди ещё три отеля",
      });
      await service.linkCardResponseRun(taken.id, "run-1");
      await service.finishCardResponse(taken.id, at(1));
      return { ...current, runs };
    }

    it("is done once a retry successor delivered its report, without changing the original response link", async () => {
      const { database, found, runs, service } = await linkedPress();
      expect(
        await runs.handOffBrowserRunRetry("run-1", {
          ...chat,
          id: "run-2",
          sessionId: "browser-session-2",
          status: "running",
          task: "Найди ещё три отеля",
        })
      ).toBe(true);
      expect(await service.readCardPress(found.id, at(2))).toMatchObject({
        stage: "searching",
      });
      await database
        .update(schema.browserRuns)
        .set({ completedAt: at(4), status: "done" })
        .where(eq(schema.browserRuns.id, "run-2"));
      await runs.finishBrowserRunReport("run-2");

      expect(
        (await runs.readBrowserRun("run-1"))?.reportDeliveredAt
      ).toBeNull();
      expect(await service.readCardPress(found.id, at(5))).toMatchObject({
        stage: "done",
      });
      expect(await service.readCardOfRun("run-2", at(5))).toMatchObject({
        id: found.id,
      });
      expect(
        await database
          .select({ runId: schema.cardResponses.runId })
          .from(schema.cardResponses)
          .where(eq(schema.cardResponses.cardId, found.id))
      ).toEqual([{ runId: "run-1" }]);
    });

    it("keeps searching for an ordinary continuation despite its delivered predecessor, for at most thirty minutes", async () => {
      const { database, found, runs, service } = await linkedPress("done");
      await runs.createBrowserRun(
        alice,
        {
          ...chat,
          id: "run-2",
          sessionId: "browser-session-2",
          status: "running",
          task: "Покажи другие варианты",
        },
        "run-1"
      );

      expect(
        (await runs.readBrowserRun("run-1"))?.reportDeliveredAt
      ).toBeInstanceOf(Date);
      expect(await service.readCardPress(found.id, at(2))).toMatchObject({
        stage: "searching",
      });
      expect(await service.readCardPress(found.id, at(29))).toMatchObject({
        stage: "searching",
      });
      expect(await service.readCardPress(found.id, at(30))).toMatchObject({
        stage: "done",
      });
      expect(
        await database
          .select({ runId: schema.cardResponses.runId })
          .from(schema.cardResponses)
          .where(eq(schema.cardResponses.cardId, found.id))
      ).toEqual([{ runId: "run-1" }]);
    });

    it("ignores a delivered successor from another workspace", async () => {
      const { database, found, runs, service } = await linkedPress();
      await runs.createBrowserRun(
        { userId: "bob", workspaceId: "workspace:bob" },
        {
          ...chat,
          completedAt: at(2),
          id: "foreign-run",
          sessionId: "browser-session-bob",
          status: "done",
          task: "Другое поручение",
        }
      );
      await runs.finishBrowserRunReport("foreign-run");
      await database
        .update(schema.browserRuns)
        .set({ retriedAsRunId: "foreign-run" })
        .where(eq(schema.browserRuns.id, "run-1"));

      expect(await service.readCardPress(found.id, at(3))).toMatchObject({
        stage: "searching",
      });
      expect(await service.readCardPress(found.id, at(30))).toMatchObject({
        stage: "done",
      });
    });
  });

  it("counts answers apart from intents", async () => {
    const { found, service } = await pressed();
    const other = await service.readCardByLink(
      (await service.createCard(alice, hotel, chat, start)).id,
      start
    );
    if (!other) throw new Error("Expected the card.");
    await service.saveCardIntent(found, press("more"), start);
    await service.claimCardResponses(start);
    await service.saveCardIntent(found, press("refresh"), start);
    await service.saveCardIntent(other, press("more"), start);
    await service.saveCardResponse(found, answer, start);

    expect(await service.countCardResponses(alice.workspaceId, start)).toBe(1);
  });

  it("takes at most six intents of one card in ten minutes, without holding back a waiting one's replacement", async () => {
    const { database, found, service } = await pressed();
    await database.insert(schema.cardResponses).values(
      Array.from({ length: 6 }, (_, index) => ({
        action: `more_${String(index)}`,
        cardId: found.id,
        ...alice,
        revision: found.revision,
        kind: "intent" as const,
        state: "delivered" as const,
        finishedAt: start,
        createdAt: start,
        summary: "Показать ещё",
        telegramUserId: "4242",
        values: {},
      }))
    );
    expect(await service.saveCardIntent(found, press("more"), start)).toBe(
      "busy"
    );
    expect(await service.saveCardIntent(found, press("more"), at(11))).toBe(
      "received"
    );
    expect(await service.saveCardIntent(found, press("refresh"), at(11))).toBe(
      "replaced"
    );
  });

  it("serializes concurrent claims and a replacement: only an unclaimed intent can change", async () => {
    const { found, rows, service } = await pressed();
    await service.saveCardIntent(found, press("more"), start);
    const [first, second, outcome] = await Promise.all([
      service.claimCardResponses(start),
      service.claimCardResponses(start),
      service.saveCardIntent(found, press("refresh"), at(1)),
    ]);
    const claimed = [...first, ...second];
    expect(claimed).toHaveLength(1);
    expect(await rows()).toHaveLength(outcome === "replaced" ? 1 : 2);
    expect(claimed[0]?.action).toBe(
      outcome === "replaced" ? "refresh" : "more"
    );
  });

  it("marks the card watched at most every ten seconds, and fresh for forty-five", async () => {
    const { database, found, service } = await pressed();
    const watched = async () =>
      (
        await database
          .select({ watchedAt: schema.cards.watchedAt })
          .from(schema.cards)
          .where(eq(schema.cards.id, found.id))
      )[0]?.watchedAt ?? null;
    const second = (count: number) => new Date(start.getTime() + count * 1000);

    await service.markCardWatched(found.id, start);
    await service.markCardWatched(found.id, second(5));
    expect(await watched()).toEqual(start);
    await service.markCardWatched(found.id, second(11));
    expect(await watched()).toEqual(second(11));

    expect(service.cardWatched(await watched(), second(55))).toBe(true);
    expect(service.cardWatched(await watched(), second(56))).toBe(false);
    expect(service.cardWatched(null, start)).toBe(false);
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

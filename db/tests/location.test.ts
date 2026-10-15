/* oxlint-disable eslint/no-await-in-loop -- Migrations and their statements must be applied in order. */
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedPoint } from "@db/services/location";
import type { NewSubscription } from "@db/services/subscriptions";
import { emptyPlaceState } from "@shared/subscriptions/place";
import * as schema from "../schema";

const databases: PGlite[] = [];
let migrated: Promise<Blob> | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

const alice = { userId: "alice", workspaceId: "workspace:alice" };
const now = new Date("2026-10-15T10:00:00.000Z");
const minute = 60_000;
const day = 24 * 60 * minute;
const home = { lat: 55.7512, lon: 37.6184 };
/** About 2 km north of home. */
const away = { lat: 55.7692, lon: 37.6184 };

function point(overrides: Partial<SharedPoint> = {}): SharedPoint {
  return {
    accuracyM: 20,
    address: null,
    arriveAllowed: true,
    externalId: `telegram:1:${String(Math.random())}:1`,
    kind: "position",
    label: null,
    lat: home.lat,
    leaveAllowed: true,
    live: false,
    liveKey: null,
    lon: home.lon,
    recordedAt: now,
    source: "telegram",
    ...overrides,
  };
}

type NewPlaceReminder = Extract<NewSubscription, { template: "place" }>;

function reminder(overrides: Partial<NewPlaceReminder> = {}): NewPlaceReminder {
  return {
    checkEverySeconds: 86_400,
    condition: { on: "arrive", repeat: false, text: "забрать посылку" },
    conversation: { conversationChannel: "telegram", conversationId: "100::" },
    dedupeKey: `arrive:${home.lat.toFixed(3)},${home.lon.toFixed(3)}`,
    description: "Place reminder: when the person arrives at «дом»",
    expiresAt: new Date(now.getTime() + 14 * day),
    source: {
      address: "Тверская улица 7, Москва",
      label: "дом",
      lat: home.lat,
      lon: home.lon,
      origin: "home",
      radiusM: 150,
    },
    state: { ...emptyPlaceState },
    template: "place",
    wake: "urgent_at_night",
    ...overrides,
  };
}

describe("shared locations", { timeout: 30_000 }, () => {
  it("stores a point once and finds the latest, by name too", async () => {
    const { location } = await openDatabase();
    const first = await location.insertPoint(alice, {
      ...point({ externalId: "telegram:1:5:100" }),
    });
    expect(first?.kind).toBe("position");
    // A redelivered update writes nothing.
    expect(
      await location.insertPoint(
        alice,
        point({ externalId: "telegram:1:5:100" })
      )
    ).toBeUndefined();
    const parked = await location.insertPoint(
      alice,
      point({
        externalId: "telegram:1:6:200",
        recordedAt: new Date(now.getTime() + minute),
      })
    );
    expect(parked).toBeDefined();
    if (!parked) return;
    expect(await location.labelPoint(alice, parked.id, "парковка")).toBe(true);
    await location.insertPoint(
      alice,
      point({
        externalId: "telegram:1:7:300",
        kind: "place",
        recordedAt: new Date(now.getTime() + 2 * minute),
      })
    );
    const latest = await location.latestPosition(alice, { now });
    expect(latest?.point.id).toBe(parked.id);
    expect(latest?.live).toBe(false);
    expect(
      (await location.latestPosition(alice, { label: "Парковка", now }))?.point
        .id
    ).toBe(parked.id);
    await expect(
      location.insertPoint(alice, point({ lat: 91 }))
    ).rejects.toThrow(/Failed query/u);
  });

  it("lends a nearby point's address and forgets by period or whole", async () => {
    const { db, location, subscriptions } = await openDatabase();
    const kept = await location.insertPoint(
      alice,
      point({ address: "Тверская улица 7, Москва" })
    );
    expect(kept).toBeDefined();
    expect(
      await location.cachedAddressNear(alice, home.lat + 0.0001, home.lon, now)
    ).toBe("Тверская улица 7, Москва");
    expect(
      await location.cachedAddressNear(alice, away.lat, away.lon, now)
    ).toBeUndefined();
    await location.insertPoint(
      alice,
      point({ recordedAt: new Date(now.getTime() - 2 * day) })
    );
    expect(
      await location.forgetLocation(alice.workspaceId, {
        from: new Date(now.getTime() - 3 * day),
        to: new Date(now.getTime() - day),
      })
    ).toEqual({ points: 1, reminders: 0 });
    // A reminder that is over goes with «забудь, где я был»; a live one stays.
    const ended = await subscriptions.createSubscription(
      alice,
      reminder(),
      now
    );
    await subscriptions.setSubscriptionStatus(
      alice,
      ended.subscription.id,
      "deleted",
      now
    );
    const live = await subscriptions.createSubscription(
      alice,
      reminder({
        condition: { on: "leave", repeat: false, text: "свет" },
        dedupeKey: "leave:x",
      }),
      now
    );
    expect(await location.forgetLocation(alice.workspaceId)).toEqual({
      points: 1,
      reminders: 1,
    });
    const left = await db.select().from(schema.subscriptions);
    expect(left.map((row) => row.id)).toEqual([live.subscription.id]);
  });

  it("lists the person's own positions of a period, oldest first, the latest kept on a cut", async () => {
    const { location } = await openDatabase();
    for (const [index, overrides] of [
      { recordedAt: new Date(now.getTime() - 3 * minute) },
      { recordedAt: new Date(now.getTime() - 2 * minute) },
      { recordedAt: new Date(now.getTime() - minute) },
      // Neither a place they forwarded nor a venue is where they went.
      { kind: "place" as const, recordedAt: now },
      { source: "telegram_venue" as const, recordedAt: now },
      { recordedAt: new Date(now.getTime() - 2 * day) },
    ].entries()) {
      await location.insertPoint(
        alice,
        point({ ...overrides, externalId: `telegram:1:${String(index)}:1` })
      );
    }
    const range = { from: new Date(now.getTime() - day), to: now };
    const all = await location.listLocationPoints(alice, {
      ...range,
      limit: 10,
    });
    expect(all.truncated).toBe(false);
    expect(all.points.map((row) => row.recordedAt.getTime())).toEqual([
      now.getTime() - 3 * minute,
      now.getTime() - 2 * minute,
      now.getTime() - minute,
    ]);
    const cut = await location.listLocationPoints(alice, {
      ...range,
      limit: 2,
    });
    expect(cut.truncated).toBe(true);
    expect(cut.points.map((row) => row.recordedAt.getTime())).toEqual([
      now.getTime() - 2 * minute,
      now.getTime() - minute,
    ]);
  });

  it("stores the web chat's point once per 10 s, never as a leave", async () => {
    const { location } = await openDatabase();
    const fine = { accuracyM: 30, lat: home.lat, lon: home.lon };
    expect(await location.recordWebShare(alice, fine, now)).toEqual({
      shared: true,
    });
    expect(
      await location.recordWebShare(
        alice,
        fine,
        new Date(now.getTime() + 5_000)
      )
    ).toEqual({ shared: false });
    expect(
      await location.recordWebShare(
        alice,
        fine,
        new Date(now.getTime() + 11_000)
      )
    ).toEqual({ shared: true });
    const shared = await location.latestWebShare(
      alice,
      new Date(now.getTime() - minute)
    );
    expect(shared).toMatchObject({ kind: "position", source: "web" });
  });

  it("sweeps points past 90 days and reminders ended a month ago", async () => {
    const { db, location, subscriptions } = await openDatabase();
    await location.insertPoint(
      alice,
      point({ recordedAt: new Date(now.getTime() - 91 * day) })
    );
    await location.insertPoint(
      alice,
      point({ recordedAt: new Date(now.getTime() - 89 * day) })
    );
    const ended = await subscriptions.createSubscription(
      alice,
      reminder(),
      new Date(now.getTime() - 40 * day)
    );
    await subscriptions.setSubscriptionStatus(
      alice,
      ended.subscription.id,
      "deleted",
      new Date(now.getTime() - 35 * day)
    );
    await location.expireLocationPoints(now);
    expect(await db.select().from(schema.locationPoints)).toHaveLength(1);
    expect(await db.select().from(schema.subscriptions)).toHaveLength(0);
  });
});

describe("the geofence of place reminders", { timeout: 30_000 }, () => {
  it("fires once on arriving, with a pending report for a live edit", async () => {
    const { db, location, subscriptions } = await openDatabase();
    const created = await subscriptions.createSubscription(
      alice,
      reminder(),
      new Date(now.getTime() - 60 * minute)
    );
    expect(created.subscription).toMatchObject({
      nextCheckAt: created.subscription.expiresAt,
      wake: "urgent_at_night",
    });
    const outside = await location.recordShared(
      alice,
      point({ ...away, recordedAt: new Date(now.getTime() - 5 * minute) }),
      { now, via: "live" }
    );
    expect(outside.hits).toEqual([]);
    const inside = await location.recordShared(alice, point(), {
      now,
      via: "live",
    });
    expect(inside.hits).toEqual([
      expect.objectContaining({
        label: "дом",
        on: "arrive",
        text: "забрать посылку",
      }),
    ]);
    const [row] = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.id, created.subscription.id));
    expect(row?.status).toBe("fired");
    const runs = await db.select().from(schema.scheduledAgentRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      reportStatus: "pending",
      status: "completed",
    });
    expect(JSON.stringify(runs[0]?.outcome)).toContain("забрать посылку");
    // A second point inside fires nothing more.
    const again = await location.recordShared(
      alice,
      point({ recordedAt: new Date(now.getTime() + minute) }),
      { now: new Date(now.getTime() + minute), via: "live" }
    );
    expect(again.hits).toEqual([]);
  });

  it("leaves the report of a point in the person's message to their turn", async () => {
    const { db, location, subscriptions } = await openDatabase();
    await subscriptions.createSubscription(
      alice,
      reminder(),
      new Date(now.getTime() - 60 * minute)
    );
    const { hits } = await location.recordShared(alice, point(), {
      now,
      via: "message",
    });
    expect(hits).toHaveLength(1);
    const runs = await db.select().from(schema.scheduledAgentRuns);
    expect(runs[0]?.reportStatus).toBe("suppressed");
  });

  it("does not fire for a reminder made a moment ago, or one past its term", async () => {
    const { db, location, subscriptions } = await openDatabase();
    await subscriptions.createSubscription(alice, reminder(), now);
    expect(
      (await location.recordShared(alice, point(), { now, via: "message" }))
        .hits
    ).toEqual([]);
    await db
      .update(schema.subscriptions)
      .set({ expiresAt: new Date(now.getTime() + 30_000) });
    expect(
      (
        await location.recordShared(
          alice,
          point({ ...away, recordedAt: new Date(now.getTime() + minute) }),
          { now: new Date(now.getTime() + minute), via: "message" }
        )
      ).hits
    ).toEqual([]);
  });

  it("fires one hit for two points at once", async () => {
    const { db, location, subscriptions } = await openDatabase();
    await subscriptions.createSubscription(
      alice,
      reminder(),
      new Date(now.getTime() - 60 * minute)
    );
    const results = await Promise.all([
      location.recordShared(alice, point(), { now, via: "message" }),
      location.recordShared(
        alice,
        point({ recordedAt: new Date(now.getTime() + 1000) }),
        { now, via: "message" }
      ),
    ]);
    expect(results.flatMap((result) => result.hits)).toHaveLength(1);
    expect(await db.select().from(schema.scheduledAgentRuns)).toHaveLength(1);
  });
});

describe("place reminders as subscriptions", { timeout: 30_000 }, () => {
  it("wait for their term when set up again or resumed, and list with prices", async () => {
    const { subscriptions } = await openDatabase();
    const first = await subscriptions.createSubscription(
      alice,
      reminder(),
      now
    );
    const later = new Date(now.getTime() + day);
    const again = await subscriptions.createSubscription(
      alice,
      reminder({
        condition: { on: "arrive", repeat: false, text: "купить хлеб" },
        expiresAt: new Date(later.getTime() + 7 * day),
        wake: "day_only",
      }),
      later
    );
    expect(again.created).toBe(false);
    expect(again.subscription).toMatchObject({
      id: first.subscription.id,
      nextCheckAt: new Date(later.getTime() + 7 * day),
      wake: "day_only",
    });
    await subscriptions.setSubscriptionStatus(
      alice,
      first.subscription.id,
      "paused",
      later
    );
    const resumed = await subscriptions.setSubscriptionStatus(
      alice,
      first.subscription.id,
      "active",
      later
    );
    expect(resumed?.nextCheckAt).toEqual(new Date(later.getTime() + 7 * day));
    expect(
      (await subscriptions.listLiveSubscriptions(alice)).map(
        (row) => row.template
      )
    ).toEqual(["place"]);
    // Nothing for the tick until the term ends.
    expect(
      await subscriptions.claimDueSubscriptions({
        leaseForMs: 10 * minute,
        limit: 10,
        now: new Date(later.getTime() + day),
      })
    ).toEqual([]);
  });
});

async function migrateOnce() {
  const client = new PGlite();
  const migrations = (await readdir(new URL("../migrations", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  for (const migration of migrations) {
    await applyMigration(client, migration);
  }
  await client.exec(`
    INSERT INTO "user" ("id", "name", "email") VALUES
      ('alice', 'Alice', 'alice@example.com');
    INSERT INTO workspaces ("id") VALUES ('workspace:alice');
    INSERT INTO workspace_memberships ("workspace_id", "user_id", "role") VALUES
      ('workspace:alice', 'alice', 'owner');
  `);
  const dump = await client.dumpDataDir("none");
  await client.close();
  return dump;
}

async function openDatabase() {
  migrated ??= migrateOnce();
  const client = new PGlite({ loadDataDir: await migrated });
  databases.push(client);
  const pgliteDatabase = drizzle(client, { schema });
  // Modules are reset between cases, so the services must see this copy.
  const Database = await import("@db");
  // SAFETY: PGlite implements the query-builder surface exercised by this service while retaining the shared Drizzle schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The focused test swaps only the database driver.
  vi.spyOn(Database, "db", "get").mockReturnValue(pgliteDatabase as never);
  return {
    db: pgliteDatabase,
    location: await import("@db/services/location"),
    subscriptions: await import("@db/services/subscriptions"),
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

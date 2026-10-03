/* oxlint-disable eslint/no-await-in-loop -- Migrations and their statements must be applied in order. */
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewSubscription } from "@db/services/subscriptions";
import * as schema from "../schema";

const databases: PGlite[] = [];
let migrated: Promise<Blob> | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

const alice = { userId: "alice", workspaceId: "workspace:alice" };
const now = new Date("2026-10-02T10:00:00.000Z");
const sixHours = 6 * 60 * 60;

function priceWatch(overrides: Partial<NewSubscription> = {}): NewSubscription {
  return {
    checkEverySeconds: sixHours,
    condition: { amount: 8_000, kind: "below" },
    conversation: { conversationChannel: "telegram", conversationId: "100::" },
    dedupeKey: "shop.example/p/1",
    description: "Price watch: «Чайник», below 8 000 RUB.",
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    source: {
      currency: "RUB",
      extractor: "jsonld",
      landedOn: "shop.example/p/1",
      name: "Чайник",
      sku: "K-1",
      url: "https://shop.example/p/1",
    },
    state: { baseline: 8_990, last: 8_990, lastSeenAt: now.toISOString() },
    template: "price",
    ...overrides,
  };
}

const hitOutcome = {
  kind: "result" as const,
  summary: "«Чайник» now costs 7 490 RUB.",
  urgency: "normal" as const,
};

// The first case migrates the shared template database, which takes seconds.
describe("event subscriptions", { timeout: 30_000 }, () => {
  it("keeps one live watch per page, which a new request updates", async () => {
    const { db, jobs, subscriptions } = await openDatabase();
    const first = await subscriptions.createSubscription(
      alice,
      priceWatch(),
      now
    );
    expect(first.created).toBe(true);
    expect(first.subscription).toMatchObject({
      nextCheckAt: new Date(now.getTime() + sixHours * 1_000),
      status: "active",
      template: "price",
    });
    const again = await subscriptions.createSubscription(
      alice,
      priceWatch({ condition: { amount: 7_000, kind: "below" } }),
      now
    );
    expect(again.created).toBe(false);
    expect(again.subscription.id).toBe(first.subscription.id);
    expect(again.subscription.condition).toEqual({
      amount: 7_000,
      kind: "below",
    });
    expect(await db.query.subscriptions.findMany()).toHaveLength(1);

    // The hidden job is no task the person lists or the dispatcher runs.
    const job = await db.query.scheduledAgentJobs.findFirst();
    expect(job).toMatchObject({ kind: "subscription", nextRunAt: null });
    expect(await jobs.listScheduledAgentJobs(alice)).toEqual([]);
    expect(
      await jobs.materializeDueScheduledAgentRuns({
        limit: 10,
        now: new Date("2026-12-30T00:00:00.000Z"),
      })
    ).toEqual([]);
  });

  it("keeps one watch when two turns set up the same page at once", async () => {
    const { db, subscriptions } = await openDatabase();
    const results = await Promise.all([
      subscriptions.createSubscription(alice, priceWatch(), now),
      subscriptions.createSubscription(
        alice,
        priceWatch({ condition: { amount: 7_000, kind: "below" } }),
        now
      ),
    ]);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(await db.query.subscriptions.findMany()).toHaveLength(1);
    expect(await db.query.scheduledAgentJobs.findMany()).toHaveLength(1);
  });

  it("leases a due watch and writes a quiet check without any run", async () => {
    const { db, subscriptions } = await openDatabase();
    await subscriptions.createSubscription(alice, priceWatch(), now);
    const due = new Date(now.getTime() + sixHours * 1_000);
    const lease = { leaseForMs: 10 * 60_000, limit: 10, now: due };
    const [claim] = await subscriptions.claimDueSubscriptions(lease);
    if (!claim) throw new Error("Expected a due watch.");
    expect(await subscriptions.claimDueSubscriptions(lease)).toEqual([]);

    const next = new Date(due.getTime() + sixHours * 1_000);
    expect(
      await subscriptions.settleSubscriptionCheck(
        claim,
        {
          kind: "quiet",
          nextCheckAt: next,
          state: {
            baseline: 8_990,
            last: 8_790,
            lastSeenAt: due.toISOString(),
          },
        },
        due
      )
    ).toBe("quiet");
    // A tick that lost the lease writes nothing.
    expect(
      await subscriptions.settleSubscriptionCheck(
        claim,
        { kind: "hit", outcome: hitOutcome },
        due
      )
    ).toBeUndefined();
    const row = await db.query.subscriptions.findFirst();
    expect(row).toMatchObject({
      checks: 1,
      hits: 0,
      nextCheckAt: next,
      state: { last: 8_790 },
      status: "active",
    });
    expect(await db.query.scheduledAgentRuns.findMany()).toEqual([]);
  });

  it("turns a hit into a finished run whose report waits to be sent", async () => {
    const { db, jobs, subscriptions } = await openDatabase();
    const { subscription } = await subscriptions.createSubscription(
      alice,
      priceWatch(),
      now
    );
    const due = new Date(now.getTime() + sixHours * 1_000);
    const [claim] = await subscriptions.claimDueSubscriptions({
      leaseForMs: 10 * 60_000,
      limit: 10,
      now: due,
    });
    if (!claim) throw new Error("Expected a due watch.");
    expect(
      await subscriptions.settleSubscriptionCheck(
        claim,
        { kind: "hit", outcome: hitOutcome },
        due
      )
    ).toBe("fired");
    expect(await db.query.subscriptions.findFirst()).toMatchObject({
      hits: 1,
      lastHitAt: due,
      status: "fired",
    });
    const reports = await jobs.listRecoverableScheduledReports(due);
    expect(reports).toEqual([
      expect.objectContaining({
        jobId: subscription.jobId,
        jobKind: "subscription",
        timeSensitive: false,
      }),
    ]);
    // A fired watch is checked no more.
    expect(
      await subscriptions.claimDueSubscriptions({
        leaseForMs: 10 * 60_000,
        limit: 10,
        now: new Date("2026-12-30T00:00:00.000Z"),
      })
    ).toEqual([]);
    expect(await subscriptions.readSubscriptionWake(subscription.jobId)).toBe(
      "day_only"
    );
  });

  it("stops after the third failure in a row and tells the person once", async () => {
    const { db, subscriptions } = await openDatabase();
    await subscriptions.createSubscription(alice, priceWatch(), now);
    let at = new Date(now.getTime() + sixHours * 1_000);
    const outcomes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [claim] = await subscriptions.claimDueSubscriptions({
        leaseForMs: 10 * 60_000,
        limit: 10,
        now: at,
      });
      if (!claim) throw new Error("Expected a due watch.");
      const next = new Date(at.getTime() + 60 * 60_000);
      outcomes.push(
        await subscriptions.settleSubscriptionCheck(
          claim,
          {
            error: "blocked: http 403",
            kind: "failed",
            nextCheckAt: next,
            outcome: {
              kind: "blocked",
              summary: "The watch stopped.",
              userActionNeeded: "Offer a browser check.",
            },
          },
          at
        )
      );
      at = next;
    }
    expect(outcomes).toEqual(["failed", "failed", "failed"]);
    expect(await db.query.subscriptions.findFirst()).toMatchObject({
      failures: 3,
      lastError: "blocked: http 403",
      status: "failed",
    });
    const runs = await db.query.scheduledAgentRuns.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: { kind: "blocked" },
      reportStatus: "pending",
      status: "completed",
    });
  });

  it("pauses, resumes and deletes a watch of the person's only", async () => {
    const { db, subscriptions } = await openDatabase();
    const { subscription } = await subscriptions.createSubscription(
      alice,
      priceWatch(),
      now
    );
    const bob = { userId: "bob", workspaceId: "workspace:bob" };
    expect(
      await subscriptions.setSubscriptionStatus(bob, subscription.id, "deleted")
    ).toBeUndefined();

    const later = new Date(now.getTime() + 60_000);
    expect(
      await subscriptions.setSubscriptionStatus(
        alice,
        subscription.id,
        "paused",
        later
      )
    ).toMatchObject({ status: "paused" });
    expect(
      await subscriptions.claimDueSubscriptions({
        leaseForMs: 10 * 60_000,
        limit: 10,
        now: new Date("2026-10-20T00:00:00.000Z"),
      })
    ).toEqual([]);
    expect(
      await subscriptions.setSubscriptionStatus(
        alice,
        subscription.id,
        "active",
        later
      )
    ).toMatchObject({ nextCheckAt: later, status: "active" });
    expect(await subscriptions.listLiveSubscriptions(alice)).toHaveLength(1);

    await subscriptions.setSubscriptionStatus(
      alice,
      subscription.id,
      "deleted",
      later
    );
    expect(await subscriptions.listLiveSubscriptions(alice)).toEqual([]);
    expect(await db.query.scheduledAgentJobs.findFirst()).toMatchObject({
      status: "deleted",
    });
    // A deleted watch frees its page for a new one.
    expect(
      (await subscriptions.createSubscription(alice, priceWatch(), later))
        .created
    ).toBe(true);
  });

  it("sends the news of a watch set up again to the chat it was asked in last", async () => {
    const { db, subscriptions } = await openDatabase();
    await subscriptions.createSubscription(
      alice,
      priceWatch({ replyAnchorMessageId: "message-1" }),
      now
    );
    await subscriptions.createSubscription(
      alice,
      priceWatch({
        conversation: { conversationChannel: "eve", conversationId: "chat-2" },
      }),
      now
    );
    expect(await db.query.scheduledAgentJobs.findFirst()).toMatchObject({
      conversationChannel: "eve",
      conversationId: "chat-2",
      replyAnchorMessageId: null,
    });
  });

  it("ends a paused watch whose term ran out, without a word", async () => {
    const { db, subscriptions } = await openDatabase();
    const { subscription } = await subscriptions.createSubscription(
      alice,
      priceWatch(),
      now
    );
    await subscriptions.setSubscriptionStatus(
      alice,
      subscription.id,
      "paused",
      now
    );
    expect(
      await subscriptions.claimDueSubscriptions({
        leaseForMs: 10 * 60_000,
        limit: 10,
        now: new Date("2026-12-30T00:00:00.000Z"),
      })
    ).toEqual([]);
    expect(await db.query.subscriptions.findFirst()).toMatchObject({
      status: "expired",
    });
    expect(await db.query.scheduledAgentJobs.findFirst()).toMatchObject({
      status: "completed",
    });
    expect(await db.query.scheduledAgentRuns.findMany()).toEqual([]);
  });

  it("holds a watch without counting a check, and lets a held one lapse quietly", async () => {
    const { db, subscriptions } = await openDatabase();
    // Its term ends between the held check and the next one.
    await subscriptions.createSubscription(
      alice,
      priceWatch({ expiresAt: new Date(now.getTime() + 7 * 60 * 60_000) }),
      now
    );
    const due = new Date(now.getTime() + sixHours * 1_000);
    const lease = { leaseForMs: 10 * 60_000, limit: 10, now: due };
    const [claim] = await subscriptions.claimDueSubscriptions(lease);
    if (!claim) throw new Error("Expected a due watch.");
    const later = new Date(due.getTime() + sixHours * 1_000);
    expect(
      await subscriptions.settleSubscriptionCheck(
        claim,
        { kind: "held", nextCheckAt: later },
        due
      )
    ).toBe("held");
    expect(await db.query.subscriptions.findFirst()).toMatchObject({
      checks: 0,
      nextCheckAt: later,
      status: "active",
    });
    const [again] = await subscriptions.claimDueSubscriptions({
      ...lease,
      now: later,
    });
    if (!again) throw new Error("Expected the held watch again.");
    expect(
      await subscriptions.settleSubscriptionCheck(
        again,
        { kind: "lapsed" },
        later
      )
    ).toBe("lapsed");
    expect(await db.query.subscriptions.findFirst()).toMatchObject({
      status: "expired",
    });
    expect(await db.query.scheduledAgentRuns.findMany()).toEqual([]);
  });

  it("keeps one watch per flight on the proactive job, and ends a moved one's", async () => {
    const { db, subscriptions } = await openDatabase();
    const jobId = await proactiveJob(db);
    const dp405 = {
      eventId: "dp405",
      location: "Аэропорт Внуково (VKO), терминал A",
      start: "2026-10-03T07:05:00+03:00",
      summary: "Рейс DP 405 Москва (Внуково) — Сочи",
    };
    const sync = (flights: readonly (typeof dp405)[], at = now) =>
      subscriptions.syncFlightWatches({
        flights,
        jobId,
        now: at,
        scope: alice,
        seenUntil: new Date(at.getTime() + 26 * 60 * 60_000),
      });
    expect(await sync([dp405])).toEqual({ ended: 0, started: 1 });
    // The next check sees the same flight: nothing new.
    expect(await sync([dp405])).toEqual({ ended: 0, started: 0 });
    const [started] = await db.query.subscriptions.findMany();
    expect(started).toMatchObject({
      action: "worker",
      dedupeKey: "dp405@2026-10-03T07:05:00+03:00",
      expiresAt: new Date("2026-10-03T04:05:00.000Z"),
      jobId,
      nextCheckAt: now,
      state: { done: [] },
      template: "flight",
      wake: "urgent_at_night",
    });
    // The flight moved to 09:00: the old watch goes, a new one starts.
    const moved = { ...dp405, start: "2026-10-03T09:00:00+03:00" };
    expect(await sync([moved])).toEqual({ ended: 1, started: 1 });
    expect(
      (await db.query.subscriptions.findMany()).map(
        ({ dedupeKey, status }) => ({ dedupeKey, status })
      )
    ).toEqual([
      { dedupeKey: "dp405@2026-10-03T09:00:00+03:00", status: "active" },
    ]);
    // Moved back, it is watched again; its reminders' own dedupe keeps
    // them from going out twice.
    expect(await sync([dp405, moved])).toEqual({ ended: 0, started: 1 });
    await sync([moved]);
    // A flight beyond what the calendar read covered is not taken as gone.
    const far = {
      ...dp405,
      eventId: "far",
      start: "2026-10-09T09:00:00+03:00",
    };
    await sync([moved, far]);
    expect(await sync([moved])).toEqual({ ended: 0, started: 0 });
    // A flight whose watch ended (every reminder went out) gets no new one.
    await db
      .update(schema.subscriptions)
      .set({ status: "fired" })
      .where(eq(schema.subscriptions.status, "active"));
    expect(await sync([moved])).toEqual({ ended: 0, started: 0 });
    // A flight already gone gets no watch.
    expect(
      await sync([{ ...dp405, eventId: "past", start: "2026-10-01T09:00:00Z" }])
    ).toMatchObject({ started: 0 });
  });

  it("settles a flight's check on its lease, and never touches the proactive job", async () => {
    const { db, subscriptions } = await openDatabase();
    const jobId = await proactiveJob(db);
    await subscriptions.syncFlightWatches({
      flights: [
        {
          eventId: "dp405",
          location: null,
          start: "2026-10-03T07:05:00+03:00",
          summary: "Рейс DP 405",
        },
      ],
      jobId,
      now,
      scope: alice,
      seenUntil: new Date(now.getTime() + 26 * 60 * 60_000),
    });
    const lease = { leaseForMs: 10 * 60_000, limit: 10, now };
    const [claim] = await subscriptions.claimDueSubscriptions(lease);
    if (!claim) throw new Error("Expected the flight's watch.");
    const evening = new Date("2026-10-02T15:00:00.000Z");
    expect(
      await subscriptions.settleFlightWatch(
        claim,
        { kind: "next", nextCheckAt: evening, state: { done: ["checkin"] } },
        now
      )
    ).toBe("waiting");
    // A tick that lost the lease writes nothing.
    expect(
      await subscriptions.settleFlightWatch(
        claim,
        { kind: "ended", status: "fired" },
        now
      )
    ).toBeUndefined();
    expect(await db.query.subscriptions.findFirst()).toMatchObject({
      checks: 1,
      nextCheckAt: evening,
      state: { done: ["checkin"] },
      status: "active",
    });

    // Held past its term outside the pilot, it ends; its job goes on.
    const [late] = await subscriptions.claimDueSubscriptions({
      ...lease,
      now: new Date("2026-10-03T05:00:00.000Z"),
    });
    if (!late) throw new Error("Expected the flight's watch again.");
    expect(
      await subscriptions.settleSubscriptionCheck(late, { kind: "lapsed" })
    ).toBe("lapsed");
    expect(await db.query.scheduledAgentJobs.findFirst()).toMatchObject({
      kind: "proactive",
      status: "active",
    });
    expect(await db.query.scheduledAgentRuns.findMany()).toEqual([]);

    // The facts of its reminders are found by the event.
    expect(
      await subscriptions.listFlightWatches(alice.workspaceId, ["dp405"])
    ).toMatchObject([{ source: { eventId: "dp405" }, template: "flight" }]);
  });

  it("lists and changes only the person's own watches, not Bro's flights", async () => {
    const { subscriptions, db } = await openDatabase();
    const jobId = await proactiveJob(db);
    await subscriptions.syncFlightWatches({
      flights: [
        {
          eventId: "dp405",
          location: null,
          start: "2026-10-03T07:05:00+03:00",
          summary: "Рейс DP 405",
        },
      ],
      jobId,
      now,
      scope: alice,
      seenUntil: new Date(now.getTime() + 26 * 60 * 60_000),
    });
    const [flight] = await db.query.subscriptions.findMany();
    if (!flight) throw new Error("Expected the flight's watch.");
    expect(await subscriptions.listLiveSubscriptions(alice)).toEqual([]);
    expect(
      await subscriptions.setSubscriptionStatus(alice, flight.id, "deleted")
    ).toBeUndefined();
    expect(await db.query.scheduledAgentJobs.findFirst()).toMatchObject({
      status: "active",
    });
  });

  it("refuses a watch checked more often than hourly or kept past 90 days", async () => {
    const { subscriptions } = await openDatabase();
    await expect(
      subscriptions.createSubscription(
        alice,
        priceWatch({ checkEverySeconds: 600 }),
        now
      )
    ).rejects.toThrow(/Failed query/u);
    await expect(
      subscriptions.createSubscription(
        alice,
        priceWatch({
          expiresAt: new Date(now.getTime() + 91 * 24 * 60 * 60_000),
        }),
        now
      )
    ).rejects.toThrow(/Failed query/u);
  });
});

/** The workspace's hidden proactive job, which flights' watches ride on. */
async function proactiveJob(
  database: Awaited<ReturnType<typeof openDatabase>>["db"]
) {
  const [job] = await database
    .insert(schema.scheduledAgentJobs)
    .values({
      conversationChannel: "telegram",
      conversationId: "100::",
      createdByUserId: alice.userId,
      kind: "proactive",
      missedRunPolicy: "skip",
      nextRunAt: null,
      prompt: "Проверить почту и календарь.",
      status: "active",
      timing: {
        anchoredAt: now.toISOString(),
        everyMinutes: 15,
        kind: "interval",
      },
      workspaceId: alice.workspaceId,
    })
    .returning({ id: schema.scheduledAgentJobs.id });
  if (!job) throw new Error("Expected the proactive job.");
  return job.id;
}

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
      ('alice', 'Alice', 'alice@example.com'), ('bob', 'Bob', 'bob@example.com');
    INSERT INTO workspaces ("id") VALUES ('workspace:alice'), ('workspace:bob');
    INSERT INTO workspace_memberships ("workspace_id", "user_id", "role") VALUES
      ('workspace:alice', 'alice', 'owner'), ('workspace:bob', 'bob', 'owner');
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
    jobs: await import("@db/services/scheduled-agent-jobs"),
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

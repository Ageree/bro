/* oxlint-disable eslint/no-await-in-loop -- Migrations and their statements must be applied in order. */
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
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

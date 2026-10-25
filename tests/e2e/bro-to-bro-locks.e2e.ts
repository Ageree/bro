/**
 * Bro ↔ Bro's locks on a real Postgres, which PGlite — one connection, one
 * transaction at a time — cannot show: an envoy's step and a change of the
 * link made at the same moment from another connection. No model and no
 * network beyond the database, so it costs nothing; not part of
 * `pnpm check` all the same, since it needs a Postgres.
 *
 *   DATABASE_URL=… (migrated, as for tests/e2e/bro-to-bro.e2e.ts) \
 *     pnpm exec vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/bro-to-bro-locks.e2e.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as z from "zod";

const session = z
  .object({ DATABASE_URL: z.string().min(1) })
  // oxlint-disable-next-line eslint/no-restricted-properties -- The run reads the session's settings once, before any module validates its own.
  .parse(process.env);
vi.stubEnv("BRO_TO_BRO_WORKSPACES", "*");

const [invites, links, threads, steps, database, { sql }] = await Promise.all([
  import("@db/services/bro-to-bro/invites"),
  import("@db/services/bro-to-bro/links"),
  import("@db/services/bro-to-bro/threads"),
  import("@db/services/bro-to-bro/steps"),
  import("@db"),
  import("drizzle-orm"),
]);
const { db } = database;
const runId = Date.now().toString(36);
/** How long a step that waits for a lock is given before it counts as waiting. */
const waitMs = 500;

afterAll(async () => {
  await db.$client.end();
});

/** Savely and Petya, linked, with a thread Savely started and leased. */
async function leasedThread(tag: string) {
  const base = `e2e-bro-locks-${runId}-${tag}`;
  const savely = {
    userId: `better-auth:${base}-savely`,
    workspaceId: `${base}-savely`,
  };
  const petya = {
    userId: `better-auth:${base}-petya`,
    workspaceId: `${base}-petya`,
  };
  for (const { userId, workspaceId } of [savely, petya])
    // oxlint-disable-next-line eslint/no-await-in-loop -- Two people sign up one after the other.
    await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`INSERT INTO workspaces (id) VALUES (${workspaceId})`
      );
      await transaction.execute(
        sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`
      );
    });
  const created = await invites.createBroInvite(savely, { label: null });
  if (created.kind !== "created") throw new Error("No invite.");
  await invites.openBroInvite(created.token, petya);
  const accepted = await invites.acceptOpenedBroInvite(petya, "telegram");
  if (accepted.kind !== "accepted") throw new Error("Not accepted.");
  const [own] = await links.listBroLinks(savely);
  if (!own) throw new Error("No link.");
  await links.confirmBroLink(savely, own.id, "cabinet");
  const started = await threads.startBroThread(savely, {
    linkId: own.id,
    mandate: {
      details: null,
      durationMinutes: null,
      goal: "Поужинать на выходных",
      window: null,
    },
    reportTarget: null,
  });
  if (started.kind !== "started") throw new Error(started.reason);
  const claimed = await steps.claimDueBroThreads({
    leaseMs: 120_000,
    limit: 50,
  });
  const lease = claimed.find((each) => each.threadId === started.threadId);
  const view = await threads.readBroThreadForSide(
    started.threadId,
    savely.workspaceId
  );
  if (!lease || !view?.link) throw new Error("The thread is not due.");
  const { revisions } = view.link;
  return {
    linkId: own.id,
    petya,
    savely,
    step: () =>
      steps.recordEnvoyStep(started.threadId, lease.leaseToken, {
        linkRevisions: revisions,
        outcome: {
          kind: "sent",
          message: { action: "message", body: "Привет! Поужинаем?" },
        },
        outOfScope: [],
        side: view.side,
        threadVersion: view.version,
      }),
    threadId: started.threadId,
  };
}

/** Another connection, as another request of the app would be. */
async function connection() {
  const client = new Client({ connectionString: session.DATABASE_URL });
  await client.connect();
  return client;
}

/** What a promise settled to within the wait, or that it still waits. */
async function within<T>(promise: Promise<T>) {
  return Promise.race([
    promise.then((value) => ({ settled: value })),
    sleep(waitMs).then(() => "waiting" as const),
  ]);
}

describe("Bro ↔ Bro on a real Postgres", () => {
  it("makes an envoy's step wait for a change of the link under way, and drops it when it was built before", async () => {
    const thread = await leasedThread("rights");
    const other = await connection();
    try {
      await other.query("BEGIN");
      await other.query(
        "UPDATE bro_links SET share_notes = 'Работаю до 18', revision = revision + 1 WHERE id = $1",
        [thread.linkId]
      );
      const step = thread.step();
      const early = await within(step);
      await other.query("COMMIT");

      expect(early).toBe("waiting");
      expect(await step).toEqual({ kind: "rejected", reason: "link" });
    } finally {
      await other.end();
    }
  });

  it("removes a link while a step holds its thread without a deadlock", async () => {
    const thread = await leasedThread("remove");
    const other = await connection();
    try {
      // What an envoy's step locks, in its order: the thread, then the link.
      await other.query("BEGIN");
      await other.query("SELECT id FROM bro_threads WHERE id = $1 FOR UPDATE", [
        thread.threadId,
      ]);
      const removed = links.removeBroLink(thread.savely, thread.linkId);
      expect(await within(removed)).toBe("waiting");
      await other.query(
        "SELECT id FROM bro_links WHERE workspace_id IN ($1, $2) AND removed_at IS NULL FOR SHARE",
        [thread.savely.workspaceId, thread.petya.workspaceId]
      );
      await other.query("COMMIT");

      expect(await removed).toEqual({ cancelledThreads: 1, kind: "removed" });
    } finally {
      await other.end();
    }
  });
});

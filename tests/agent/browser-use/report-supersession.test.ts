import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@db/schema";
import {
  browserRunReportDelivered,
  claimBrowserRunReport,
  createBrowserRun,
  createQueuedBrowserRun,
  readBrowserRun,
  readLatestBrowserRunForScope,
} from "@db/services/browser-runs";

const client = new PGlite();
const database = drizzle(client, { schema });
const scope = { userId: "better-auth:alice", workspaceId: "workspace:alice" };

vi.mock("@db", async (importOriginal) => ({
  ...(await importOriginal()),
  get db() {
    return database;
  },
}));

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
}, 60_000);

afterAll(async () => {
  await client.close();
});

describe("a queued predecessor report after a follow-up", () => {
  it("keeps the report on failed continuation, then suppresses it only after the new run is recorded", async () => {
    await createBrowserRun(scope, {
      id: "old-run",
      conversationChannel: "eve",
      conversationId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000001",
      task: "Sign in",
      status: "done",
      completedAt: new Date(),
      report: "Needs: push\nDetails: code from app notification",
    });

    expect(await browserRunReportDelivered("old-run")).toBe(false);
    expect(await claimBrowserRunReport("old-run")).toBeDefined();

    await createBrowserRun(
      scope,
      {
        id: "new-run",
        conversationChannel: "eve",
        conversationId: "00000000-0000-4000-8000-000000000001",
        sessionId: "00000000-0000-4000-8000-000000000001",
        task: "Enter the code",
        status: "running",
      },
      "old-run"
    );
    expect(await browserRunReportDelivered("old-run")).toBe(true);
    expect((await readLatestBrowserRunForScope(scope, "old-run"))?.id).toBe(
      "new-run"
    );
    expect(await claimBrowserRunReport("old-run")).toBeUndefined();
  });

  it("links a queued successor atomically, without leaving an orphan when the predecessor is missing", async () => {
    await createBrowserRun(scope, {
      id: "old-queued-run",
      conversationChannel: "eve",
      conversationId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000001",
      task: "Sign in",
      status: "done",
      completedAt: new Date(),
      report: "Needs: push",
    });
    const queued = {
      conversationChannel: "eve" as const,
      conversationId: "00000000-0000-4000-8000-000000000001",
      pendingTask: "Resume sign-in",
      retryAt: new Date(Date.now() + 60_000),
      task: "Resume sign-in",
    };

    const before = await database
      .select({ id: schema.browserRuns.id })
      .from(schema.browserRuns);
    await expect(
      createQueuedBrowserRun(scope, queued, "missing-run")
    ).rejects.toThrow("predecessor run was already replaced");
    expect(
      await database
        .select({ id: schema.browserRuns.id })
        .from(schema.browserRuns)
    ).toEqual(before);
    expect(await browserRunReportDelivered("old-queued-run")).toBe(false);

    const successor = await createQueuedBrowserRun(
      scope,
      queued,
      "old-queued-run"
    );
    expect(successor.status).toBe("queued");
    expect(
      (await readLatestBrowserRunForScope(scope, "old-queued-run"))?.id
    ).toBe(successor.id);
    expect(await browserRunReportDelivered("old-queued-run")).toBe(true);
    expect(await claimBrowserRunReport("old-queued-run")).toBeUndefined();
  });

  it("rolls back a successor when its predecessor cannot be linked", async () => {
    const otherScope = {
      userId: "better-auth:bob",
      workspaceId: "workspace:bob",
    };
    await createBrowserRun(scope, {
      id: "pending-run",
      conversationChannel: "eve",
      conversationId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000001",
      task: "Sign in",
      status: "done",
      completedAt: new Date(),
      report: "Needs: push",
    });

    await expect(
      createBrowserRun(
        otherScope,
        {
          id: "rejected-run",
          conversationChannel: "eve",
          conversationId: "00000000-0000-4000-8000-000000000002",
          sessionId: "00000000-0000-4000-8000-000000000002",
          task: "Enter the code",
          status: "running",
        },
        "pending-run"
      )
    ).rejects.toThrow("predecessor run was already replaced");
    expect(await readBrowserRun("rejected-run")).toBeUndefined();
    expect(await browserRunReportDelivered("pending-run")).toBe(false);
    expect(await claimBrowserRunReport("pending-run")).toBeDefined();
  });
});

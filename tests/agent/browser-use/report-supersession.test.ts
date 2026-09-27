import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import {
  browserRunReportDelivered,
  claimBrowserRunReport,
  createBrowserRun,
  linkBrowserRunFollowUp,
  readBrowserRun,
  readLatestBrowserRunForScope,
} from "@db/services/browser-runs";

const client = new PGlite();
const database = drizzle(client, { schema });
const scope = { userId: "better-auth:alice", workspaceId: "workspace:alice" };

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract as the service's database driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite implements the service's Drizzle contract.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
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
    expect(await linkBrowserRunFollowUp(scope, "old-run", "missing-run")).toBe(
      false
    );
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

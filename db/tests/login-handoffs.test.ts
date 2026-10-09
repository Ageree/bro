import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 30_000 });

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };
const start = new Date("2026-10-09T10:00:00Z");
const minutes = (count: number) => count * 60_000;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function handoffs() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const [Database, scope, service] = await Promise.all([
    import("@db"),
    import("@db/services/scope"),
    import("@db/services/login-handoffs"),
  ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await scope.ensureScope(bob);
  return service;
}

function link(id: string, who = alice, overrides = {}) {
  return {
    allowedDomains: ["ozon.ru"],
    conversationChannel: "telegram" as const,
    conversationId: "telegram:1",
    createdByUserId: who.userId,
    domain: "ozon.ru",
    expiresAt: new Date(start.getTime() + minutes(30)),
    id,
    siteUrl: "https://www.ozon.ru/",
    workspaceId: who.workspaceId,
    ...overrides,
  };
}

describe("login handoffs", () => {
  it("lets the first device that opens a link own it, and no other", async () => {
    const service = await handoffs();
    await service.createLoginHandoff(link("link-1"), start);
    const later = new Date(start.getTime() + minutes(1));
    const first = await service.claimLoginHandoff(
      {
        deviceHash: "phone",
        id: "link-1",
        viewMs: minutes(10),
        workerId: "w1",
      },
      later
    );
    expect(first.kind).toBe("claimed");
    // The same device asks again (a reload, a browser still starting).
    expect(
      (
        await service.claimLoginHandoff(
          {
            deviceHash: "phone",
            id: "link-1",
            viewMs: minutes(10),
            workerId: "w2",
          },
          later
        )
      ).kind
    ).toBe("again");
    expect(
      (
        await service.claimLoginHandoff(
          {
            deviceHash: "laptop",
            id: "link-1",
            viewMs: minutes(10),
            workerId: "w3",
          },
          later
        )
      ).kind
    ).toBe("taken");
    expect((await service.readLoginHandoff("link-1"))?.workerId).toBe("w1");
    expect(
      (
        await service.claimLoginHandoff(
          { deviceHash: "phone", id: "nope", viewMs: 1, workerId: "w" },
          later
        )
      ).kind
    ).toBe("missing");
  });

  it("refuses a link past its time, and a viewer that ran out of it", async () => {
    const service = await handoffs();
    await service.createLoginHandoff(link("link-1"), start);
    const late = new Date(start.getTime() + minutes(31));
    expect(
      (
        await service.claimLoginHandoff(
          {
            deviceHash: "phone",
            id: "link-1",
            viewMs: minutes(10),
            workerId: "w1",
          },
          late
        )
      ).kind
    ).toBe("expired");
    await service.createLoginHandoff(link("link-2"), start);
    await service.claimLoginHandoff(
      {
        deviceHash: "phone",
        id: "link-2",
        viewMs: minutes(10),
        workerId: "w2",
      },
      start
    );
    expect(
      (
        await service.claimLoginHandoff(
          {
            deviceHash: "phone",
            id: "link-2",
            viewMs: minutes(10),
            workerId: "w2",
          },
          new Date(start.getTime() + minutes(11))
        )
      ).kind
    ).toBe("taken");
  });

  it("withdraws an unopened link when a new one is made, and waits for an open one", async () => {
    const service = await handoffs();
    await service.createLoginHandoff(link("old"), start);
    await service.createLoginHandoff(
      link("new", alice, { domain: "avito.ru" }),
      start
    );
    expect((await service.readLoginHandoff("old"))?.state).toBe("cancelled");
    await service.claimLoginHandoff(
      { deviceHash: "phone", id: "new", viewMs: minutes(10), workerId: "w" },
      start
    );
    expect((await service.createLoginHandoff(link("third"), start)).kind).toBe(
      "busy"
    );
    // Another person's workspace is not held by it.
    expect(
      (await service.createLoginHandoff(link("bobs", bob), start)).kind
    ).toBe("created");
  });

  it("remembers when the worker took a handoff in, once", async () => {
    const service = await handoffs();
    await service.createLoginHandoff(link("link-1"), start);
    await service.claimLoginHandoff(
      { deviceHash: "phone", id: "link-1", viewMs: minutes(10), workerId: "w" },
      start
    );
    expect(
      (await service.readLoginHandoff("link-1"))?.workerOpenedAt
    ).toBeNull();
    const first = new Date(start.getTime() + minutes(1));
    await service.markLoginHandoffWorkerOpened("link-1", first);
    await service.markLoginHandoffWorkerOpened(
      "link-1",
      new Date(start.getTime() + minutes(5))
    );
    expect((await service.readLoginHandoff("link-1"))?.workerOpenedAt).toEqual(
      first
    );
  });

  it("ends a handoff once, and delivers its report once", async () => {
    const service = await handoffs();
    await service.createLoginHandoff(link("link-1"), start);
    await service.claimLoginHandoff(
      { deviceHash: "phone", id: "link-1", viewMs: minutes(10), workerId: "w" },
      start
    );
    const ended = await service.endLoginHandoff(
      "link-1",
      {
        report: "Signed in.",
        resultHost: "www.ozon.ru",
        signedIn: true,
        state: "done",
      },
      start
    );
    expect(ended?.state).toBe("done");
    // The viewer's finish and the settling tick both say so: the second is nothing.
    expect(
      await service.endLoginHandoff(
        "link-1",
        { report: "Expired.", state: "expired" },
        start
      )
    ).toBeUndefined();
    expect((await service.readLoginHandoff("link-1"))?.report).toBe(
      "Signed in."
    );
    const [owed] = await service.claimLoginHandoffReports(start);
    expect(owed?.id).toBe("link-1");
    expect(await service.claimLoginHandoffReports(start)).toEqual([]); // under its lease
    await service.releaseLoginHandoffReport("link-1");
    expect(await service.claimLoginHandoffReports(start)).toHaveLength(1);
    await service.markLoginHandoffReportDelivered("link-1", start);
    expect(
      await service.claimLoginHandoffReports(
        new Date(start.getTime() + minutes(10))
      )
    ).toEqual([]);
  });

  it("owes no report to a person who ended it themselves, and gives up on a report that keeps failing", async () => {
    const service = await handoffs();
    await service.createLoginHandoff(link("quiet"), start);
    await service.endLoginHandoff(
      "quiet",
      { report: null, state: "cancelled" },
      start
    );
    expect(await service.claimLoginHandoffReports(start)).toEqual([]);
    await service.createLoginHandoff(link("loud"), start);
    await service.endLoginHandoff(
      "loud",
      { report: "Signed in.", state: "done" },
      start
    );
    let at = start;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      at = new Date(at.getTime() + minutes(3));
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each delivery is tried after the lease of the last ran out.
      expect(await service.claimLoginHandoffReports(at)).toHaveLength(1);
    }
    expect(
      await service.claimLoginHandoffReports(
        new Date(at.getTime() + minutes(3))
      )
    ).toEqual([]);
  });

  it("expires links nobody opened and lists the open viewers", async () => {
    const service = await handoffs();
    await service.createLoginHandoff(link("unopened"), start);
    await service.expireLoginHandoffs(new Date(start.getTime() + minutes(31)));
    expect((await service.readLoginHandoff("unopened"))?.state).toBe("expired");
    expect(await service.claimLoginHandoffReports(start)).toEqual([]);
    await service.createLoginHandoff(link("open", bob), start);
    await service.claimLoginHandoff(
      { deviceHash: "phone", id: "open", viewMs: minutes(10), workerId: "w" },
      start
    );
    expect(
      (await service.listClaimedLoginHandoffs()).map((row) => row.id)
    ).toEqual(["open"]);
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

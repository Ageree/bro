import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "ws_alice" };
const bob = { userId: "bob", workspaceId: "ws_bob" };
const carol = { userId: "carol", workspaceId: "ws_carol" };
const dave = { userId: "dave", workspaceId: "ws_dave" };
const erin = { userId: "erin", workspaceId: "ws_erin" };
const now = new Date("2026-09-28T12:00:00.000Z");
const minutes = (count: number) => new Date(now.getTime() + count * 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function browserVmsDatabase() {
  // The spy and the services under test have to come from one module registry,
  // so the reset happens before both are imported.
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const pgliteDatabase = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = pgliteDatabase as never;
  const [Database, scope, browserVms] = await Promise.all([
    import("@db"),
    import("@db/services/scope"),
    import("@db/services/browser-vms"),
  ]);
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await Promise.all(
    [alice, bob, carol, dave, erin].map(async (who) => scope.ensureScope(who))
  );
  // Runs take their creation time from the database clock, which two inserts
  // in one millisecond share; the cases that order runs set it here.
  const createdAt = async (id: string, at: Date) => {
    await client.query(
      "UPDATE browser_vm_runs SET created_at = $1 WHERE id = $2",
      [at.toISOString(), id]
    );
  };
  return { browserVms, client, createdAt };
}

function run(id: string, task: string, sessionId = "vm:ws_alice:s:one") {
  return { id, sessionId, task, workspaceId: alice.workspaceId };
}

describe("browser VM persistence", () => {
  it("starts a workspace with a stopped record and no VM", async () => {
    const { browserVms } = await browserVmsDatabase();

    expect(await browserVms.readBrowserVm(alice.workspaceId)).toBeUndefined();
    const created = await browserVms.ensureBrowserVmRecord(alice.workspaceId);
    expect(created).toMatchObject({
      generation: 0,
      leaseUntil: null,
      profileGeneration: 1,
      healthFailures: 0,
      profileResetPending: false,
      recoveries: 0,
      state: "stopped",
      vmId: null,
      workspaceId: alice.workspaceId,
    });

    await browserVms.updateBrowserVm(
      alice.workspaceId,
      { generation: 1, state: "creating", vmId: "vm-1" },
      now
    );
    // A second caller finds the record the first one made, not a fresh one.
    expect(
      await browserVms.ensureBrowserVmRecord(alice.workspaceId)
    ).toMatchObject({ generation: 1, state: "creating", vmId: "vm-1" });
    expect(await browserVms.readBrowserVm(bob.workspaceId)).toBeUndefined();
  }, 20_000);

  it("lets one caller at a time hold the lifecycle lease", async () => {
    const { browserVms } = await browserVmsDatabase();
    expect(
      await browserVms.claimBrowserVmLease(alice.workspaceId, now, 120_000)
    ).toBeUndefined();
    await browserVms.ensureBrowserVmRecord(alice.workspaceId);

    const first = await browserVms.claimBrowserVmLease(
      alice.workspaceId,
      now,
      120_000
    );
    expect(first).toMatchObject({ claimedAt: now, leaseUntil: minutes(2) });
    expect(
      await browserVms.claimBrowserVmLease(
        alice.workspaceId,
        minutes(1),
        120_000
      )
    ).toBeUndefined();

    // A lease that ran out is taken over…
    const second = await browserVms.claimBrowserVmLease(
      alice.workspaceId,
      minutes(2),
      120_000
    );
    expect(second?.leaseUntil).toEqual(minutes(4));
    // …and the caller that outlived it cannot free the new holder's lease.
    await browserVms.releaseBrowserVmLease(
      alice.workspaceId,
      first?.leaseUntil ?? undefined
    );
    expect(
      (await browserVms.readBrowserVm(alice.workspaceId))?.leaseUntil
    ).toEqual(minutes(4));

    await browserVms.releaseBrowserVmLease(
      alice.workspaceId,
      second?.leaseUntil ?? undefined
    );
    expect(
      await browserVms.claimBrowserVmLease(
        alice.workspaceId,
        minutes(3),
        60_000
      )
    ).toMatchObject({ leaseUntil: minutes(4) });
    await browserVms.releaseBrowserVmLease(alice.workspaceId);
    expect(
      (await browserVms.readBrowserVm(alice.workspaceId))?.leaseUntil
    ).toBeNull();
  }, 20_000);

  it("lands a lease holder's write only while no other step took the lease", async () => {
    const { browserVms } = await browserVmsDatabase();
    await browserVms.ensureBrowserVmRecord(alice.workspaceId);
    const first = await browserVms.claimBrowserVmLease(
      alice.workspaceId,
      now,
      120_000
    );
    const firstLease = first?.leaseUntil ?? undefined;

    expect(
      await browserVms.updateBrowserVm(
        alice.workspaceId,
        { state: "starting", vmId: "vm-1" },
        now,
        firstLease
      )
    ).toMatchObject({ state: "starting", vmId: "vm-1" });

    // The step outlives its lease, and another caller takes the VM over.
    const second = await browserVms.claimBrowserVmLease(
      alice.workspaceId,
      minutes(3),
      120_000
    );
    await browserVms.updateBrowserVm(
      alice.workspaceId,
      { state: "creating", vmId: "vm-2" },
      minutes(3),
      second?.leaseUntil ?? undefined
    );
    await expect(
      browserVms.updateBrowserVm(
        alice.workspaceId,
        { state: "stopped", vmId: null },
        minutes(4),
        firstLease
      )
    ).rejects.toThrow("another step took its lease");
    expect(await browserVms.readBrowserVm(alice.workspaceId)).toMatchObject({
      state: "creating",
      vmId: "vm-2",
    });

    // A write that is not a lease holder's is not fenced.
    expect(
      await browserVms.updateBrowserVm(
        alice.workspaceId,
        { lastUsedAt: minutes(4) },
        minutes(4)
      )
    ).toMatchObject({ lastUsedAt: minutes(4), vmId: "vm-2" });
  }, 20_000);

  it("restamps the state time only when the state changes", async () => {
    const { browserVms } = await browserVmsDatabase();
    await browserVms.ensureBrowserVmRecord(alice.workspaceId);

    const creating = await browserVms.updateBrowserVm(
      alice.workspaceId,
      {
        image: "bro-browser-2026-09-28-1",
        proxyExit: {
          at: now.toISOString(),
          city: "Moscow",
          country: "RU",
          ip: "203.0.113.7",
          org: "AS0 Example",
        },
        state: "creating",
      },
      now
    );
    expect(creating.stateChangedAt).toEqual(now);
    expect(creating.updatedAt).toEqual(now);
    expect(creating.proxyExit?.country).toBe("RU");

    const same = await browserVms.updateBrowserVm(
      alice.workspaceId,
      { host: "203.0.113.10", state: "creating" },
      minutes(3)
    );
    expect(same.stateChangedAt).toEqual(now);
    expect(same.host).toBe("203.0.113.10");
    expect(same.image).toBe("bro-browser-2026-09-28-1");

    const untouched = await browserVms.updateBrowserVm(
      alice.workspaceId,
      { recoveries: 1 },
      minutes(4)
    );
    expect(untouched.stateChangedAt).toEqual(now);

    const ready = await browserVms.updateBrowserVm(
      alice.workspaceId,
      { state: "ready" },
      minutes(5)
    );
    expect(ready.stateChangedAt).toEqual(minutes(5));
    expect(ready.recoveries).toBe(1);

    await expect(
      browserVms.updateBrowserVm(bob.workspaceId, { state: "ready" }, now)
    ).rejects.toThrow("gone");
  }, 20_000);

  it("lists VMs on the move first, and settled ones only with something to do", async () => {
    const { browserVms } = await browserVmsDatabase();
    const idleBefore = minutes(-20);
    const listed = async (at = now, limit = 10) =>
      (await browserVms.listBrowserVmsToReconcile(at, idleBefore, limit)).map(
        (row) => row.workspaceId
      );
    const update = async (
      who: { readonly workspaceId: string },
      patch: Parameters<typeof browserVms.updateBrowserVm>[1],
      at = now
    ) => browserVms.updateBrowserVm(who.workspaceId, patch, at);
    await Promise.all(
      [alice, bob, carol, dave, erin].map(async (who) =>
        browserVms.ensureBrowserVmRecord(who.workspaceId)
      )
    );

    // Stopped with no VM: nothing for the reconcile to do.
    expect(await listed()).toEqual([]);

    // Up and used within the idle window, however long it has been up.
    await update(
      alice,
      { lastUsedAt: minutes(-5), state: "ready", vmId: "vm-a" },
      minutes(-90)
    );
    // Up and unused for the window.
    await update(
      carol,
      { lastUsedAt: minutes(-25), state: "ready", vmId: "vm-c" },
      minutes(-60)
    );
    // Failed with a VM that may still run; failed without one is left be.
    await update(dave, { state: "failed", vmId: "vm-d" }, minutes(-40));
    await update(erin, { state: "failed" }, minutes(-50));
    // On its way up: first, however recently it got there.
    await update(bob, { state: "starting", vmId: "vm-b" }, minutes(-1));
    expect(await listed()).toEqual([
      bob.workspaceId,
      carol.workspaceId,
      dave.workspaceId,
    ]);
    // Each part has its own limit: VMs that are up never crowd out the
    // ones on the move.
    expect(await listed(now, 1)).toEqual([bob.workspaceId, carol.workspaceId]);

    // A stopped VM is left be, unless the person asked to forget its
    // profile; so is a VM in use.
    await update(erin, { state: "stopped", vmId: "vm-e" }, minutes(-10));
    expect(await listed()).not.toContain(erin.workspaceId);
    await update(alice, { profileResetPending: true });
    await update(erin, { profileResetPending: true });
    expect(await listed()).toEqual([
      bob.workspaceId,
      alice.workspaceId,
      carol.workspaceId,
      dave.workspaceId,
      erin.workspaceId,
    ]);

    // A stopped VM given up on is left for an errand to start, even with a
    // profile to wipe.
    await update(erin, { givenUpAt: minutes(-10) });
    expect(await listed()).not.toContain(erin.workspaceId);

    // An errand holding bob's lease keeps the reconcile away until it ends.
    await browserVms.claimBrowserVmLease(bob.workspaceId, now, 120_000);
    expect(await listed(minutes(1))).not.toContain(bob.workspaceId);
    expect((await listed(minutes(2)))[0]).toBe(bob.workspaceId);
  }, 20_000);

  it("goes round the VMs in turn, so ones it can do nothing about do not keep the rest out", async () => {
    const { browserVms } = await browserVmsDatabase();
    await Promise.all(
      [alice, bob, carol].map(async (who) =>
        browserVms.ensureBrowserVmRecord(who.workspaceId)
      )
    );
    // Failed long ago, in a state the reconcile can do nothing about: its
    // state time never moves.
    await browserVms.updateBrowserVm(
      alice.workspaceId,
      { state: "failed", vmId: "vm-a" },
      minutes(-300)
    );
    await browserVms.updateBrowserVm(
      bob.workspaceId,
      { state: "failed", vmId: "vm-b" },
      minutes(-200)
    );
    // Up and idle: billed until the reconcile gets to it.
    await browserVms.updateBrowserVm(
      carol.workspaceId,
      { lastUsedAt: minutes(-60), state: "ready", vmId: "vm-c" },
      minutes(-100)
    );
    const reconcile = async (at: Date) => {
      const rows = await browserVms.listBrowserVmsToReconcile(
        at,
        minutes(-20),
        1
      );
      await Promise.all(
        rows.map(async (row) => {
          const claimed = await browserVms.claimBrowserVmLease(
            row.workspaceId,
            at,
            120_000
          );
          await browserVms.releaseBrowserVmLease(
            row.workspaceId,
            claimed?.leaseUntil ?? undefined
          );
        })
      );
      return rows.map((row) => row.workspaceId);
    };

    expect(await reconcile(now)).toEqual([alice.workspaceId]);
    expect(await reconcile(minutes(1))).toEqual([bob.workspaceId]);
    expect(await reconcile(minutes(2))).toEqual([carol.workspaceId]);
    expect(await reconcile(minutes(3))).toEqual([alice.workspaceId]);
  }, 20_000);

  it("clears a pending profile wipe only for the forget it answered", async () => {
    const { browserVms } = await browserVmsDatabase();
    await browserVms.ensureBrowserVmRecord(alice.workspaceId);
    await browserVms.updateBrowserVm(alice.workspaceId, {
      profileGeneration: 2,
      profileResetPending: true,
    });
    // The wipe for generation 2 ran while the person forgot once more.
    await browserVms.updateBrowserVm(alice.workspaceId, {
      profileGeneration: 3,
    });

    expect(
      await browserVms.clearBrowserVmProfileReset(alice.workspaceId, 2, now)
    ).toBe(false);
    expect(await browserVms.readBrowserVm(alice.workspaceId)).toMatchObject({
      profileGeneration: 3,
      profileResetPending: true,
    });
    expect(
      await browserVms.clearBrowserVmProfileReset(alice.workspaceId, 3, now)
    ).toBe(true);
    expect(await browserVms.readBrowserVm(alice.workspaceId)).toMatchObject({
      profileResetPending: false,
      updatedAt: now,
    });
    expect(
      await browserVms.clearBrowserVmProfileReset(alice.workspaceId, 3, now)
    ).toBe(false);
  }, 20_000);

  it("records a run once and never reopens a settled one", async () => {
    const { browserVms } = await browserVmsDatabase();
    const id = "vm:ws_alice:r:one";
    await browserVms.recordBrowserVmRun(run(id, "Find the kettle"));
    // Recording the same id again, as a retried dispatch does, keeps the row.
    await browserVms.recordBrowserVmRun(run(id, "Something else"));
    expect(await browserVms.readBrowserVmRun(id)).toMatchObject({
      finishedAt: null,
      result: null,
      sessionId: "vm:ws_alice:s:one",
      status: "queued",
      task: "Find the kettle",
      workspaceId: alice.workspaceId,
    });

    expect(
      await browserVms.updateBrowserVmRun(id, { status: "running" }, now)
    ).toMatchObject({ status: "running", updatedAt: now });
    expect(
      await browserVms.updateBrowserVmRun(
        id,
        {
          finalUrl: "https://www.wildberries.ru/catalog/1/detail.aspx",
          finishedAt: minutes(5),
          result: "ITEMS: kettle",
          status: "completed",
        },
        minutes(5)
      )
    ).toMatchObject({ finishedAt: minutes(5), status: "completed" });

    // A read that raced the settle with an older status leaves the row be.
    expect(
      await browserVms.updateBrowserVmRun(id, { status: "running" }, minutes(6))
    ).toBeUndefined();
    expect(await browserVms.readBrowserVmRun(id)).toMatchObject({
      result: "ITEMS: kettle",
      status: "completed",
      updatedAt: minutes(5),
    });
    // One settled status may still correct another.
    expect(
      await browserVms.updateBrowserVmRun(id, { status: "failed" }, minutes(7))
    ).toMatchObject({ status: "failed" });
    expect(
      await browserVms.updateBrowserVmRun("vm:ws_alice:r:none", {
        status: "failed",
      })
    ).toBeUndefined();
  }, 20_000);

  it("mirrors the unread messages a settled run leaves, absent when there are none", async () => {
    const { browserVms } = await browserVmsDatabase();
    const id = "vm:ws_alice:r:unread";
    await browserVms.recordBrowserVmRun(run(id, "Find the kettle"));

    expect(await browserVms.readBrowserVmRun(id)).toMatchObject({
      unreadMessages: null,
    });

    expect(
      await browserVms.updateBrowserVmRun(
        id,
        {
          error: null,
          finishedAt: now,
          result: "ITEMS: kettle",
          status: "completed",
          unreadMessages: ["Add the blue one too"],
        },
        now
      )
    ).toMatchObject({ unreadMessages: ["Add the blue one too"] });
    expect(await browserVms.readBrowserVmRun(id)).toMatchObject({
      unreadMessages: ["Add the blue one too"],
    });
  }, 20_000);

  it("finds the open runs of a workspace, newest first", async () => {
    const { browserVms, createdAt } = await browserVmsDatabase();
    await browserVms.recordBrowserVmRun(run("vm:ws_alice:r:1", "First"));
    await browserVms.recordBrowserVmRun(run("vm:ws_alice:r:2", "Follow-up"));
    await browserVms.recordBrowserVmRun(
      run("vm:ws_alice:r:3", "Other errand", "vm:ws_alice:s:two")
    );
    await browserVms.recordBrowserVmRun({
      ...run("vm:ws_bob:r:1", "Bob's errand", "vm:ws_bob:s:one"),
      workspaceId: bob.workspaceId,
    });
    await createdAt("vm:ws_alice:r:1", minutes(-30));
    await createdAt("vm:ws_alice:r:2", minutes(-10));
    await createdAt("vm:ws_alice:r:3", minutes(-20));
    await browserVms.updateBrowserVmRun("vm:ws_alice:r:1", {
      status: "completed",
    });
    await browserVms.updateBrowserVmRun("vm:ws_alice:r:3", {
      status: "dispatching",
    });

    expect(
      (await browserVms.listOpenBrowserVmRuns(alice.workspaceId)).map(
        (row) => row.id
      )
    ).toEqual(["vm:ws_alice:r:2", "vm:ws_alice:r:3"]);
  }, 20_000);

  it("finds a run by a whole line of its task from the last day", async () => {
    const { browserVms, createdAt } = await browserVmsDatabase();
    const line = "Errand id: errand-7, attempt 2";
    await browserVms.recordBrowserVmRun(
      run("vm:ws_alice:r:old", `Buy tea\n${line}`)
    );
    await browserVms.recordBrowserVmRun(
      run("vm:ws_alice:r:new", `Buy tea\n${line}\nBudget: 500`)
    );
    await browserVms.recordBrowserVmRun(
      run("vm:ws_alice:r:cancelled", `Buy tea\n${line}`)
    );
    // The line inside a longer one is not the same errand.
    await browserVms.recordBrowserVmRun(
      run("vm:ws_alice:r:partial", `Buy tea\n${line}0`)
    );
    await browserVms.recordBrowserVmRun({
      ...run("vm:ws_bob:r:1", line, "vm:ws_bob:s:one"),
      workspaceId: bob.workspaceId,
    });
    await createdAt("vm:ws_alice:r:old", minutes(-60));
    await createdAt("vm:ws_alice:r:new", minutes(-30));
    await createdAt("vm:ws_alice:r:cancelled", minutes(-5));
    await createdAt("vm:ws_alice:r:partial", minutes(-1));
    await browserVms.updateBrowserVmRun("vm:ws_alice:r:cancelled", {
      status: "cancelled",
    });

    expect(
      (
        await browserVms.findBrowserVmRunByTaskLine(
          alice.workspaceId,
          line,
          now
        )
      )?.id
    ).toBe("vm:ws_alice:r:new");
    expect(
      await browserVms.findBrowserVmRunByTaskLine(alice.workspaceId, "Buy", now)
    ).toBeUndefined();
    // A day on, the same words belong to another errand.
    expect(
      (
        await browserVms.findBrowserVmRunByTaskLine(
          alice.workspaceId,
          line,
          new Date(now.getTime() + 24 * 60 * 60_000 - 45 * 60_000)
        )
      )?.id
    ).toBe("vm:ws_alice:r:new");
    expect(
      await browserVms.findBrowserVmRunByTaskLine(
        alice.workspaceId,
        line,
        new Date(now.getTime() + 24 * 60 * 60_000)
      )
    ).toBeUndefined();
  }, 20_000);

  it("deletes the record with its runs, and keeps the workspace until then", async () => {
    const { browserVms, client } = await browserVmsDatabase();
    await browserVms.ensureBrowserVmRecord(alice.workspaceId);
    await browserVms.ensureBrowserVmRecord(bob.workspaceId);
    await browserVms.recordBrowserVmRun(run("vm:ws_alice:r:1", "Errand"));
    await browserVms.recordBrowserVmRun({
      ...run("vm:ws_bob:r:1", "Errand", "vm:ws_bob:s:one"),
      workspaceId: bob.workspaceId,
    });

    await browserVms.deleteBrowserVmRecord(alice.workspaceId);
    expect(await browserVms.readBrowserVm(alice.workspaceId)).toBeUndefined();
    expect(
      await browserVms.readBrowserVmRun("vm:ws_alice:r:1")
    ).toBeUndefined();
    expect(await browserVms.readBrowserVm(bob.workspaceId)).toBeDefined();

    // The record is the only trace of a VM that may still be billed: the
    // workspace cannot be deleted from under it.
    await expect(
      client.query("DELETE FROM workspaces WHERE id = $1", [bob.workspaceId])
    ).rejects.toThrow("browser_vms_workspace_id_workspaces_id_fk");
    expect(await browserVms.readBrowserVm(bob.workspaceId)).toBeDefined();

    // Without the record the workspace goes, and its runs with it.
    await client.query("DELETE FROM browser_vms WHERE workspace_id = $1", [
      bob.workspaceId,
    ]);
    await client.query("DELETE FROM workspaces WHERE id = $1", [
      bob.workspaceId,
    ]);
    expect(await browserVms.readBrowserVmRun("vm:ws_bob:r:1")).toBeUndefined();
  }, 20_000);
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

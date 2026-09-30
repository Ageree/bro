import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "ws_alice" };
const bob = { userId: "bob", workspaceId: "ws_bob" };
const now = new Date("2026-09-30T12:00:00.000Z");
const minutes = (count: number) => new Date(now.getTime() + count * 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function hostsDatabase() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const pgliteDatabase = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = pgliteDatabase as never;
  const [Database, scope, vms] = await Promise.all([
    import("@db"),
    import("@db/services/scope"),
    import("@db/services/browser-vms"),
  ]);
  const hosts = await import("@db/services/browser-hosts");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await Promise.all([alice, bob].map(async (who) => scope.ensureScope(who)));
  return { client, hosts, vms };
}

describe("browser host persistence", { timeout: 60_000 }, () => {
  it("hands out each host slot once, up to the limit", async () => {
    const { hosts } = await hostsDatabase();

    const [first, second] = await Promise.all([
      hosts.claimBrowserHostSlot(2, now, 120_000),
      hosts.claimBrowserHostSlot(2, now, 120_000),
    ]);
    expect(
      [first?.id ?? "", second?.id ?? ""].toSorted((a, b) => a.localeCompare(b))
    ).toEqual(["bro-host-1", "bro-host-2"]);
    expect(first).toMatchObject({
      leaseUntil: minutes(2),
      state: "creating",
      vmId: null,
    });
    expect(first?.vmName).toBe(first?.id);
    expect(await hosts.claimBrowserHostSlot(2, now, 120_000)).toBeUndefined();

    // A slot whose host is gone is taken again.
    await hosts.deleteBrowserHostRecord("bro-host-1");
    expect((await hosts.claimBrowserHostSlot(2, now, 120_000))?.id).toBe(
      "bro-host-1"
    );
    expect(
      (await hosts.listBrowserHosts()).map((host) => host.id).toSorted()
    ).toEqual(["bro-host-1", "bro-host-2"]);
  });

  it("fences writes and releases by the lease", async () => {
    const { hosts } = await hostsDatabase();
    const slot = await hosts.claimBrowserHostSlot(1, now, 120_000);
    if (slot === undefined) throw new Error("No slot.");

    // Held: nobody else claims it.
    expect(
      await hosts.claimBrowserHostLease(slot.id, minutes(1), 120_000)
    ).toBeUndefined();
    const booting = await hosts.updateBrowserHost(
      slot.id,
      { address: "45.132.176.117", state: "booting" },
      minutes(1),
      slot.leaseUntil ?? undefined
    );
    expect(booting.stateChangedAt).toEqual(minutes(1));
    // The same state again keeps its stamp.
    const same = await hosts.updateBrowserHost(
      slot.id,
      { lastSeenAt: minutes(2), state: "booting" },
      minutes(2)
    );
    expect(same.stateChangedAt).toEqual(minutes(1));

    const taken = await hosts.claimBrowserHostLease(
      slot.id,
      minutes(3),
      60_000
    );
    expect(taken?.leaseUntil).toEqual(minutes(4));
    await expect(
      hosts.updateBrowserHost(
        slot.id,
        { state: "ready" },
        minutes(3),
        slot.leaseUntil ?? undefined
      )
    ).rejects.toThrow("another step took its lease");
    // An old claim does not free the new one.
    await hosts.releaseBrowserHostLease(slot.id, slot.leaseUntil ?? undefined);
    expect((await hosts.readBrowserHost(slot.id))?.leaseUntil).toEqual(
      minutes(4)
    );
    await hosts.releaseBrowserHostLease(
      slot.id,
      taken?.leaseUntil ?? undefined
    );
    expect((await hosts.readBrowserHost(slot.id))?.leaseUntil).toBeNull();
  });

  it("counts only the live sandboxes Bro placed on a host", async () => {
    const { hosts, vms } = await hostsDatabase();
    await hosts.claimBrowserHostSlot(1, now, 120_000);
    await vms.ensureBrowserVmRecord(alice.workspaceId);
    await vms.ensureBrowserVmRecord(bob.workspaceId);

    expect(await hosts.countLiveSandboxesOnHost("bro-host-1")).toBe(0);
    await vms.updateBrowserVm(alice.workspaceId, {
      hostId: "bro-host-1",
      sandboxState: "running",
    });
    await vms.updateBrowserVm(bob.workspaceId, {
      hostId: "bro-host-1",
      sandboxState: "parked",
    });
    expect(await hosts.countLiveSandboxesOnHost("bro-host-1")).toBe(1);
    await vms.updateBrowserVm(bob.workspaceId, { sandboxState: "restoring" });
    expect(await hosts.countLiveSandboxesOnHost("bro-host-1")).toBe(2);

    // The host's record going leaves the workspaces without a host.
    await hosts.deleteBrowserHostRecord("bro-host-1");
    expect((await vms.readBrowserVm(alice.workspaceId))?.hostId).toBeNull();
  });

  it("keeps the sandbox columns within their states", async () => {
    const { client, vms } = await hostsDatabase();
    await vms.ensureBrowserVmRecord(alice.workspaceId);

    expect(
      (await vms.readBrowserVm(alice.workspaceId))?.sandboxState
    ).toBeNull();
    await expect(
      client.query(
        "UPDATE browser_vms SET sandbox_state = 'asleep' WHERE workspace_id = $1",
        [alice.workspaceId]
      )
    ).rejects.toThrow("violates check constraint");
    await expect(
      client.query(
        "UPDATE browser_vms SET snapshot_chunks = 0 WHERE workspace_id = $1",
        [alice.workspaceId]
      )
    ).rejects.toThrow("violates check constraint");
    await expect(
      client.query(
        "INSERT INTO browser_hosts (id, state, vm_name) VALUES ('Bro:1', 'ready', 'x')"
      )
    ).rejects.toThrow("violates check constraint");
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

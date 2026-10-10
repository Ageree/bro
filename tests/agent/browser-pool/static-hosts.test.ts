import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as cloudRuModule from "@agent/lib/browser-vm/cloudru";
import type * as hostModule from "@agent/lib/browser-pool/host";
import type * as ownerAlert from "@agent/lib/owner-alert";
import * as schema from "@db/schema";
import {
  browserPoolTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

/**
 * The browser pool with BROWSER_HOST_CLOUD=static: hosts an operator
 * provisioned, which Bro never creates, powers, reboots or deletes.
 */

const now = new Date("2026-09-30T12:00:00.000Z");
const minutes = (count: number) => new Date(now.getTime() + count * 60_000);
const alice = { userId: "alice", workspaceId: "ws_alice" };
const address = "203.0.113.10";
const staticSettings = {
  BROWSER_HOST_CLOUD: "static",
  BROWSER_HOST_STATIC: `static-1@${address},static-2@203.0.113.11`,
};

const cloud = vi.hoisted(() => ({
  createCloudRuHostVm: vi.fn<typeof cloudRuModule.createCloudRuHostVm>(),
  deleteCloudRuFloatingIp:
    vi.fn<typeof cloudRuModule.deleteCloudRuFloatingIp>(),
  deleteCloudRuVm: vi.fn<typeof cloudRuModule.deleteCloudRuVm>(),
  findCloudRuVmByName: vi.fn<typeof cloudRuModule.findCloudRuVmByName>(),
  listCloudRuPrivateAddresses:
    vi.fn<typeof cloudRuModule.listCloudRuPrivateAddresses>(),
  readCloudRuVm: vi.fn<typeof cloudRuModule.readCloudRuVm>(),
  setCloudRuVmPower: vi.fn<typeof cloudRuModule.setCloudRuVmPower>(),
}));
const hostClient = vi.hoisted(() => ({
  readBrowserHostCapacity: vi.fn<typeof hostModule.readBrowserHostCapacity>(),
  readBrowserHostHealth: vi.fn<typeof hostModule.readBrowserHostHealth>(),
}));
const alertOwner = vi.hoisted(() =>
  vi.fn<typeof ownerAlert.alertOwner>(() => Promise.resolve(true))
);
const clearOwnerAlert = vi.hoisted(() =>
  vi.fn<typeof ownerAlert.clearOwnerAlert>(() => Promise.resolve())
);

vi.mock("@agent/lib/browser-vm/cloudru", async (importOriginal) => ({
  ...(await importOriginal<typeof cloudRuModule>()),
  ...cloud,
}));
vi.mock("@agent/lib/browser-pool/host", async (importOriginal) => ({
  ...(await importOriginal<typeof hostModule>()),
  ...hostClient,
}));
vi.mock("@agent/lib/owner-alert", () => ({ alertOwner, clearOwnerAlert }));

const databases: PGlite[] = [];

beforeEach(() => {
  hostClient.readBrowserHostHealth.mockResolvedValue(health("ready"));
});

afterEach(async () => {
  clearBrowserVmSettings();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

function health(stage: string | null) {
  return {
    configured: true,
    hostd: "1",
    runsc: null,
    stage,
  };
}

function capacity(
  committed: number,
  sandboxes: readonly { state: string }[] = [],
  rootfsVersions = ["2026-09-30.1"]
) {
  return {
    cpu: { features: "abc", model: "Intel" },
    disk: { freeMb: 30_000, totalMb: 40_000 },
    host: "static-1",
    memoryMb: { available: 16_000 - committed, committed, total: 16_000 },
    rootfsVersions,
    runsc: null,
    sandboxes: sandboxes.map((sandbox, index) => ({
      generation: 1,
      id: `ws-${String(index)}`,
      memoryMb: 3072,
      state: sandbox.state,
      usedMb: null,
    })),
    shm: { freeMb: 8000, totalMb: 8000 },
  };
}

/** Nothing here may reach Cloud.ru, and these are the ways in. */
function expectNoComputeCall() {
  for (const mock of Object.values(cloud)) expect(mock).not.toHaveBeenCalled();
}

async function loadPool(settings: Record<string, string> = staticSettings) {
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  return importWithSettings(
    {
      ...browserPoolTestEnvironment,
      CLOUDRU_KEY_ID: "",
      CLOUDRU_KEY_SECRET: "",
      ...settings,
    },
    async () => {
      const [Database, scope, vms] = await Promise.all([
        import("@db"),
        import("@db/services/scope"),
        import("@db/services/browser-vms"),
      ]);
      const hosts = await import("@agent/lib/browser-pool/hosts");
      const records = await import("@db/services/browser-hosts");
      vi.spyOn(Database, "db", "get").mockReturnValue(database);
      await scope.ensureScope(alice);
      return { hosts, records, vms };
    }
  );
}

type Pool = Awaited<ReturnType<typeof loadPool>>;

/** A Cloud.ru host's record left over from the `cloudru` mode. */
async function seedCloudHost(
  records: Pool["records"],
  patch: Parameters<Pool["records"]["updateBrowserHost"]>[1],
  id = "bro-host-1"
) {
  const slot = await records.claimBrowserHostSlot(4, minutes(-60), 1);
  if (slot?.id !== id) {
    throw new Error(`Seeded ${String(slot?.id)}, not ${id}.`);
  }
  await records.releaseBrowserHostLease(id);
  return records.updateBrowserHost(
    id,
    {
      address: "45.132.176.117",
      floatingIpId: "fip-1",
      vmId: "vm-1",
      ...patch,
    },
    minutes(-60)
  );
}

/** Both listed hosts recorded and ready, as after two rounds. */
async function readyPool<T extends Pick<Pool, "hosts">>(pool: T) {
  hostClient.readBrowserHostCapacity.mockResolvedValue(capacity(0));
  await pool.hosts.reconcileBrowserHosts(minutes(-30));
  return pool;
}

describe("BROWSER_HOST_CLOUD=static settings", () => {
  it("lists hosts as <id>@<IPv4>, and needs the list", async () => {
    const parsed = await importWithSettings(
      { ...browserPoolTestEnvironment, ...staticSettings },
      async () => import("@shared/environment")
    );
    expect(parsed.env.BROWSER_HOST_STATIC).toEqual([
      { address, id: "static-1" },
      { address: "203.0.113.11", id: "static-2" },
    ]);
    clearBrowserVmSettings();
    const cloudru = await importWithSettings(
      browserPoolTestEnvironment,
      async () => import("@shared/environment")
    );
    expect(cloudru.env.BROWSER_HOST_CLOUD).toBe("cloudru");

    for (const settings of [
      { BROWSER_HOST_CLOUD: "static" },
      { BROWSER_HOST_CLOUD: "static", BROWSER_HOST_STATIC: " , " },
      { BROWSER_HOST_CLOUD: "static", BROWSER_HOST_STATIC: "static-1" },
      { BROWSER_HOST_CLOUD: "static", BROWSER_HOST_STATIC: "Static_1@1.2.3.4" },
      { BROWSER_HOST_CLOUD: "static", BROWSER_HOST_STATIC: "a@1.2.3.256" },
      { BROWSER_HOST_CLOUD: "static", BROWSER_HOST_STATIC: "a@host.example" },
      { BROWSER_HOST_CLOUD: "static", BROWSER_HOST_STATIC: "a@1.2.3.4@5" },
      {
        BROWSER_HOST_CLOUD: "static",
        BROWSER_HOST_STATIC: "a@1.2.3.4,a@1.2.3.5",
      },
      {
        BROWSER_HOST_CLOUD: "static",
        BROWSER_HOST_STATIC: "a@1.2.3.4,b@1.2.3.4",
      },
      { BROWSER_HOST_CLOUD: "metal", BROWSER_HOST_STATIC: "a@1.2.3.4" },
    ]) {
      clearBrowserVmSettings();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each bad value is parsed in an environment of its own.
      await expect(
        importWithSettings(
          { ...browserPoolTestEnvironment, ...settings },
          async () => import("@shared/environment")
        )
      ).rejects.toThrow("Invalid environment variables");
    }
  });

  it("does not need the Cloud.ru key for the hosts", async () => {
    const keyless = { CLOUDRU_KEY_ID: "", CLOUDRU_KEY_SECRET: "" };
    const cloudru = await importWithSettings(
      { ...browserPoolTestEnvironment, ...keyless },
      async () => import("@agent/lib/browser-vm/backend")
    );
    expect(cloudru.browserPoolConfigured()).toBe(false);
    expect(cloudru.browserStateConfigured()).toBe(false);

    // Without Cloud.ru's key the sets still need some Object Storage key.
    const noStorage = await importWithSettings(
      { ...browserPoolTestEnvironment, ...keyless, ...staticSettings },
      async () => import("@agent/lib/browser-vm/backend")
    );
    expect(noStorage.browserStateConfigured()).toBe(false);

    const hosts = await importWithSettings(
      {
        ...browserPoolTestEnvironment,
        ...keyless,
        ...staticSettings,
        CLOUDRU_S3_TENANT_ID: "",
        S3_ACCESS_KEY_ID: "selectel-key",
        S3_ENDPOINT: "https://s3.ru-1.storage.selcloud.ru",
        S3_REGION: "ru-1",
        S3_SECRET_ACCESS_KEY: "selectel-secret",
      },
      async () => import("@agent/lib/browser-vm/backend")
    );
    expect(hosts.browserPoolConfigured()).toBe(true);
    expect(hosts.browserStateConfigured()).toBe(true);
  });
});

describe("static browser hosts", { timeout: 60_000 }, () => {
  it("records the listed hosts and follows them up to ready, never asking Cloud.ru", async () => {
    const { hosts, records } = await loadPool();
    hostClient.readBrowserHostHealth.mockRejectedValue(new Error("down"));

    await hosts.reconcileBrowserHosts(now);
    expect(await records.listBrowserHosts()).toMatchObject([
      {
        address,
        bootConfig: `${"ab".repeat(32)}:2026-09-30.1:${"cd".repeat(32)}:runc:`,
        floatingIpId: null,
        id: "static-1",
        state: "booting",
        vmId: null,
        vmName: "static-1",
      },
      {
        address: "203.0.113.11",
        id: "static-2",
        state: "booting",
        vmId: null,
        vmName: "static-2",
      },
    ]);

    hostClient.readBrowserHostHealth.mockResolvedValue(health("ready"));
    hostClient.readBrowserHostCapacity.mockResolvedValue(capacity(0));
    await hosts.reconcileBrowserHosts(minutes(1));
    expect(await records.listBrowserHosts()).toMatchObject([
      { capacity: { limitMb: 14_976 }, id: "static-1", state: "ready" },
      { id: "static-2", state: "ready" },
    ]);
    // Recorded once: a round later changes nothing but what hostd said.
    await hosts.reconcileBrowserHosts(minutes(2));
    expect(await records.listBrowserHosts()).toHaveLength(2);
    expectNoComputeCall();
  });

  it("keeps an idle host ready, outside the warm hours and however long it is empty", async () => {
    const { hosts, records } = await loadPool({
      ...staticSettings,
      BROWSER_HOST_IDLE_MINUTES: "5",
      BROWSER_HOST_MIN_WARM: "1",
      BROWSER_HOST_WARM_HOURS: "08-10",
    });
    await readyPool({ hosts });

    // 15:00 in Moscow, outside the warm hours, empty for two days.
    /* oxlint-disable eslint/no-await-in-loop -- The rounds follow each other in time. */
    for (const at of [minutes(10), minutes(24 * 60), minutes(3 * 24 * 60)]) {
      await hosts.reconcileBrowserHosts(at);
      expect(
        (await records.listBrowserHosts()).map((host) => host.state)
      ).toEqual(["ready", "ready"]);
    }
    /* oxlint-enable eslint/no-await-in-loop */
    expectNoComputeCall();
  });

  it("fails a host that stops answering, and brings it back when it answers", async () => {
    const pool = await readyPool(await loadPool());
    const { hosts, records } = pool;
    hostClient.readBrowserHostCapacity.mockImplementation(async (host) => {
      if (host.id === "static-1") throw new Error("down");
      return capacity(0);
    });

    // Silent for less than five minutes: still ready.
    await hosts.reconcileBrowserHosts(minutes(-27));
    expect((await records.readBrowserHost("static-1"))?.state).toBe("ready");
    await hosts.reconcileBrowserHosts(minutes(-20));
    expect(await records.readBrowserHost("static-1")).toMatchObject({
      lastError: "The host's hostd stopped answering.",
      state: "failed",
    });
    expect((await records.readBrowserHost("static-2"))?.state).toBe("ready");
    expect(alertOwner).toHaveBeenCalledWith(
      "browser-host-failed:static-1:static",
      expect.stringContaining("static-1"),
      expect.anything()
    );
    // A failed host is not placed on, deleted or replaced.
    await hosts.reconcileBrowserHosts(minutes(10));
    expect((await records.readBrowserHost("static-1"))?.state).toBe("failed");

    hostClient.readBrowserHostCapacity.mockResolvedValue(capacity(3072));
    await hosts.reconcileBrowserHosts(minutes(11));
    expect(await records.readBrowserHost("static-1")).toMatchObject({
      capacity: { committedMb: 3072 },
      lastError: null,
      state: "ready",
    });
    expect(clearOwnerAlert).toHaveBeenCalledWith(
      "browser-host-failed:static-1:static",
      minutes(11)
    );
    expectNoComputeCall();
  });

  it("fails a host that never came up", async () => {
    const { hosts, records } = await loadPool();
    hostClient.readBrowserHostHealth.mockRejectedValue(new Error("down"));

    await hosts.reconcileBrowserHosts(now);
    await hosts.reconcileBrowserHosts(minutes(16));
    expect(await records.readBrowserHost("static-1")).toMatchObject({
      createBlockedUntil: null,
      state: "failed",
    });
    // It comes up as soon as its hostd answers.
    hostClient.readBrowserHostCapacity.mockResolvedValue(capacity(0));
    await hosts.reconcileBrowserHosts(minutes(17));
    expect((await records.readBrowserHost("static-1"))?.state).toBe("ready");
    expectNoComputeCall();
  });

  it("takes no sandbox on a host off the list, and drops its record once it is empty", async () => {
    const { hosts, records, vms } = await loadPool();
    await readyPool({ hosts, records, vms });
    // A Cloud.ru host left over from the `cloudru` mode, still ready with a
    // sandbox, and a stopped one.
    await seedCloudHost(records, { state: "ready" });
    await seedCloudHost(records, { state: "stopped" }, "bro-host-2");
    await vms.ensureBrowserVmRecord(alice.workspaceId);
    await vms.updateBrowserVm(alice.workspaceId, {
      hostId: "bro-host-1",
      sandboxState: "running",
    });

    await hosts.reconcileBrowserHosts(now);
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe(
      "draining"
    );
    // The stopped one holds no sandbox: gone, and its VM left to the operator.
    expect(await records.readBrowserHost("bro-host-2")).toBeUndefined();

    // Placement skips it, even when it is the fullest and fits.
    hostClient.readBrowserHostCapacity.mockImplementation(async (host) =>
      capacity(host.id === "bro-host-1" ? 6_144 : 0)
    );
    const placed = await hosts.placeBrowserSandbox(minutes(1));
    expect(placed.kind === "ready" ? placed.host.id : placed).toMatch(
      /^static-/u
    );

    await hosts.reconcileBrowserHosts(minutes(2));
    expect((await records.readBrowserHost("bro-host-1"))?.state).toBe(
      "draining"
    );
    await vms.updateBrowserVm(alice.workspaceId, { sandboxState: "parked" });
    await hosts.reconcileBrowserHosts(minutes(3));
    expect(await records.readBrowserHost("bro-host-1")).toBeUndefined();
    expect((await records.listBrowserHosts()).map((host) => host.id)).toEqual([
      "static-1",
      "static-2",
    ]);
    expectNoComputeCall();
  });

  it("drops a host taken off the list, as soon as its hostd holds no sandbox", async () => {
    const { hosts, records } = await loadPool({
      ...staticSettings,
      BROWSER_HOST_STATIC: `static-1@${address}`,
    });
    await records.insertStaticBrowserHost(
      { address: "203.0.113.11", bootConfig: null, id: "static-2" },
      minutes(-30)
    );
    await records.updateBrowserHost("static-2", { state: "ready" });
    hostClient.readBrowserHostCapacity.mockResolvedValue(
      capacity(3072, [{ state: "running" }])
    );

    // Its hostd still holds a sandbox: it only stops taking new ones.
    await hosts.reconcileBrowserHosts(now);
    expect((await records.readBrowserHost("static-2"))?.state).toBe("draining");
    hostClient.readBrowserHostCapacity.mockResolvedValue(capacity(0));
    await hosts.reconcileBrowserHosts(minutes(1));
    expect((await records.listBrowserHosts()).map((host) => host.id)).toEqual([
      "static-1",
    ]);
    expectNoComputeCall();
  });

  it("serves the sandbox that fits and never makes a host for one that does not", async () => {
    const pool = await readyPool(await loadPool());
    const { hosts, records } = pool;
    await records.updateBrowserHost("static-2", {
      capacity: {
        committedMb: 6_144,
        limitMb: 14_976,
        rootfsVersions: ["2026-09-30.1"],
        runsc: null,
        sandboxes: 2,
      },
    });
    hostClient.readBrowserHostCapacity.mockImplementation(async (host) =>
      capacity(host.id === "static-2" ? 6_144 : 0)
    );

    const placed = await hosts.placeBrowserSandbox(minutes(1));
    // The fuller host that fits first.
    expect(placed.kind === "ready" ? placed.host.id : placed).toBe("static-2");

    // Everything full: the existing pool-full answer and alert, no creation,
    // no waiting for a host to be woken or made.
    hostClient.readBrowserHostCapacity.mockResolvedValue(capacity(12_288));
    expect(await hosts.placeBrowserSandbox(minutes(2))).toEqual({
      kind: "starting",
      retryAfterMs: 15_000,
    });
    expect(alertOwner).toHaveBeenCalledWith(
      "browser-pool-full",
      expect.stringContaining("static-1, static-2"),
      expect.anything()
    );
    expect(await records.listBrowserHosts()).toHaveLength(2);

    // A warm-up takes a host in service or none, and starts nothing.
    expect(
      await hosts.placeBrowserSandbox(minutes(3), { inServiceOnly: true })
    ).toMatchObject({ kind: "starting" });
    await hosts.prewarmBrowserPool(minutes(4));
    expect(await hosts.browserPoolWait(minutes(4))).toEqual({
      minutes: 1,
      phase: "ready",
    });
    expectNoComputeCall();
  });

  it("places a sandbox on a listed host the moment its hostd answers, before any round of the reconcile", async () => {
    // The servers are always on: a person's errand must not wait a tick for
    // a host to be recorded or found ready.
    const { hosts, records } = await loadPool();
    hostClient.readBrowserHostCapacity.mockResolvedValue(capacity(0));
    expect(await records.listBrowserHosts()).toEqual([]);

    const placed = await hosts.placeBrowserSandbox(now);
    expect(placed).toMatchObject({ host: { id: "static-1" }, kind: "ready" });
    expect(await records.listBrowserHosts()).toMatchObject([
      { id: "static-1", state: "ready" },
      { id: "static-2", state: "ready" },
    ]);

    // With a host in service, one that failed is left to the reconcile: its
    // silent hostd would hold every errand for its timeout.
    await records.updateBrowserHost("static-2", { state: "failed" });
    hostClient.readBrowserHostHealth.mockClear();
    hostClient.readBrowserHostCapacity.mockClear();
    await hosts.placeBrowserSandbox(minutes(1));
    expect(hostClient.readBrowserHostCapacity.mock.calls).toEqual([
      [expect.objectContaining({ id: "static-1" })],
    ]);
    expectNoComputeCall();
  });

  it("asks soon again when no host is up, without waiting for one to be made", async () => {
    const { hosts } = await loadPool();
    hostClient.readBrowserHostHealth.mockRejectedValue(new Error("down"));
    await hosts.reconcileBrowserHosts(now);

    expect(await hosts.placeBrowserSandbox(minutes(2))).toEqual({
      kind: "starting",
      retryAfterMs: 15_000,
    });
    expectNoComputeCall();
  });

  it("serves only what fits on a host without the current root, and tells the owner to update it", async () => {
    const pool = await loadPool();
    const { hosts, records } = pool;
    hostClient.readBrowserHostCapacity.mockResolvedValue(
      capacity(0, [], ["2026-08-01.1"])
    );
    await hosts.reconcileBrowserHosts(now);
    await hosts.reconcileBrowserHosts(minutes(1));

    // Not drained, not deleted, not replaced.
    expect(
      (await records.listBrowserHosts()).map((host) => host.state)
    ).toEqual(["ready", "ready"]);
    expect(alertOwner).toHaveBeenCalledWith(
      "browser-host-outdated:static-1",
      expect.stringContaining("2026-09-30.1"),
      expect.anything()
    );
    expect(await hosts.placeBrowserSandbox(minutes(2))).toEqual({
      kind: "starting",
      retryAfterMs: 15_000,
    });
    expect(alertOwner).not.toHaveBeenCalledWith(
      "browser-pool-full",
      expect.anything(),
      expect.anything()
    );

    // The one that has the root is served.
    hostClient.readBrowserHostCapacity.mockImplementation(async (host) =>
      capacity(0, [], host.id === "static-2" ? ["2026-09-30.1"] : [])
    );
    const placed = await hosts.placeBrowserSandbox(minutes(3));
    expect(placed.kind === "ready" ? placed.host.id : placed).toBe("static-2");
    expectNoComputeCall();
  });

  it("charges no flavor for the time of a sandbox on a static host", async () => {
    const costs = await importWithSettings(
      { ...browserPoolTestEnvironment, ...staticSettings },
      async () => import("@agent/lib/costs/browser")
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      await costs.recordBrowserSandboxUptime("ws_alice", now, minutes(30))
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../../../db/migrations/", import.meta.url);
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
